import {
  barFadeDurationMs,
  computeTransitionDsp,
  computeWaveformAndAutoGain,
  equalPowerGains,
  findCueSpot,
  getActiveExitSpot,
  getExitQualityAtTime,
  getNextBeatOneSec,
  mixTempo,
  phaseLockRate,
  planMixTransition,
  TRACK_CUES_VERSION,
  type DeckId,
  type BeatGrid,
  type CueSpot,
  type FadeBars,
  type TransitionPlan,
  type MixMode,
  type TrackCues,
} from "@/core/dj-math";
import { keyFit } from "@/core/key-detect";
import { analysisScheduler } from "@/lib/analysis-scheduler";

export interface TrackItem {
  id: string;
  file?: File;
  remoteUrl?: string;
  size: number;
  lastModified: number;
  filename: string;
  title: string;
  artist: string;
  duration: number | null;
  bpm: number | null;
  cues: TrackCues | null;
  coverUrl: string | null;
  metadataLoaded: boolean;
}

export interface DeckSnapshot {
  track: TrackItem | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  cues: TrackCues | null;
  selectedEntryBar: number | null;
  /** Playhead the DJ set by hand on the idle deck; overrides the entry flag when set. */
  manualEntrySec: number | null;
  peaks: number[];
  peaksLoading: boolean;
  autoGain: number;
  bpm: number | null;
  waveformLocked: boolean;
}

type EngineListener = () => void;

interface DeckInternals {
  audio: HTMLAudioElement;
  source: MediaElementAudioSourceNode | null;
  autoGainNode: GainNode | null;
  bassFilterNode: BiquadFilterNode | null;
  hpfFilterNode: BiquadFilterNode | null;
  crossfadeGainNode: GainNode | null;
  softStopGainNode: GainNode | null;
  echoSendNode: GainNode | null;
  echoDelayNode: DelayNode | null;
  echoFilterNode: BiquadFilterNode | null;
  echoFeedbackNode: GainNode | null;
  softStopTimerId: number | null;
  tempoGlideRafId: number | null;
  objectUrl: string | null;
  loadSeq: number;
  snapshot: DeckSnapshot;
}

function emptyDeck(): DeckSnapshot {
  return {
    track: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    cues: null,
    selectedEntryBar: null,
    manualEntrySec: null,
    peaks: [],
    peaksLoading: false,
    autoGain: 1,
    bpm: null,
    waveformLocked: false,
  };
}

/** How often the phase lock re-measures the beat offset during a blend. */
const PHASE_LOCK_INTERVAL_MS = 250;

export class DjAudioEngine {
  private ctx: AudioContext | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private decks: Record<DeckId, DeckInternals>;
  private crossfade = 0; // 0 = full A, 1 = full B
  private masterVolume = 0.85;
  private mixMode: MixMode = "smart";
  private fadeBars: FadeBars = 16;
  /** The transition in progress, driven by the timer (Fade to) or by the DJ's fader. */
  private mix: ActiveMix | null = null;
  private onMixComplete: ((finishedOldDeck: DeckId) => void) | null = null;
  private activeTransitionLabel: string | null = null;
  private fadeRafId: number | null = null;
  private pendingBeatTimerId: number | null = null;
  private pendingBeatRafId: number | null = null;
  private fadeSeq = 0;
  private isAutoFading = false;
  private lastStartErrorMs: number | null = null;
  private listeners = new Set<EngineListener>();
  private onDeckEnded: ((id: DeckId) => void) | null = null;
  private rafTickId: number | null = null;

  setOnMixComplete(cb: ((finishedOldDeck: DeckId) => void) | null): void {
    this.onMixComplete = cb;
  }

  setOnDeckEnded(cb: ((id: DeckId) => void) | null): void {
    this.onDeckEnded = cb;
  }

  constructor() {
    this.decks = {
      A: this.createDeckInternals("A"),
      B: this.createDeckInternals("B"),
    };
  }

  private createDeckInternals(id: DeckId): DeckInternals {
    const audio = new Audio();
    audio.preload = "auto";
    audio.crossOrigin = "anonymous";
    const pitchAudio = audio as HTMLAudioElement & {
      preservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    pitchAudio.preservesPitch = true;
    if ("webkitPreservesPitch" in pitchAudio) {
      pitchAudio.webkitPreservesPitch = true;
    }

    const internals: DeckInternals = {
      audio,
      source: null,
      autoGainNode: null,
      bassFilterNode: null,
      hpfFilterNode: null,
      crossfadeGainNode: null,
      softStopGainNode: null,
      echoSendNode: null,
      echoDelayNode: null,
      echoFilterNode: null,
      echoFeedbackNode: null,
      softStopTimerId: null,
      tempoGlideRafId: null,
      objectUrl: null,
      loadSeq: 0,
      snapshot: emptyDeck(),
    };

    audio.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(audio.duration)) {
        internals.snapshot = {
          ...internals.snapshot,
          duration: audio.duration,
        };
        this.emit();
      }
    });

    audio.addEventListener("play", () => {
      internals.snapshot = {
        ...internals.snapshot,
        isPlaying: true,
        waveformLocked: this.isDeckAudible(id),
      };
      this.ensureRafLoop();
      this.emit();
    });

    audio.addEventListener("pause", () => {
      internals.snapshot = {
        ...internals.snapshot,
        isPlaying: false,
        waveformLocked: false,
      };
      this.emit();
    });

    audio.addEventListener("ended", () => {
      const wasAudible = this.isDeckAudible(id);
      internals.snapshot = {
        ...internals.snapshot,
        isPlaying: false,
        currentTime: internals.snapshot.duration,
        waveformLocked: false,
      };
      this.emit();
      if (wasAudible && !this.isAutoFading) {
        this.onDeckEnded?.(id);
      }
    });

    return internals;
  }

  private ensureAudioGraph(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -2;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.15;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;

      this.limiter.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);
    }

    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }

    for (const id of ["A", "B"] as const) {
      const d = this.decks[id];
      d.audio.volume = 1;
      d.audio.muted = false;
      if (!d.source && this.ctx && this.limiter) {
        d.source = this.ctx.createMediaElementSource(d.audio);
        d.autoGainNode = this.ctx.createGain();

        // Smart Mix low-shelf EQ (200 Hz) + high-pass sweep filter (resting at 20 Hz transparent)
        d.bassFilterNode = this.ctx.createBiquadFilter();
        d.bassFilterNode.type = "lowshelf";
        d.bassFilterNode.frequency.value = 200;
        d.bassFilterNode.gain.value = 0;

        d.hpfFilterNode = this.ctx.createBiquadFilter();
        d.hpfFilterNode.type = "highpass";
        d.hpfFilterNode.frequency.value = 20;
        d.hpfFilterNode.Q.value = 0.707;

        d.softStopGainNode = this.ctx.createGain();
        d.crossfadeGainNode = this.ctx.createGain();

        // Parallel BPM-synced dub/club echo-out send (silent at rest)
        d.echoSendNode = this.ctx.createGain();
        d.echoSendNode.gain.value = 0;
        d.echoDelayNode = this.ctx.createDelay(1.0);
        d.echoDelayNode.delayTime.value = 0.375;
        d.echoFilterNode = this.ctx.createBiquadFilter();
        d.echoFilterNode.type = "bandpass";
        d.echoFilterNode.frequency.value = 1200;
        d.echoFilterNode.Q.value = 0.85;
        d.echoFeedbackNode = this.ctx.createGain();
        d.echoFeedbackNode.gain.value = 0.44;

        const { gainA, gainB } = equalPowerGains(this.crossfade);
        d.autoGainNode.gain.value = d.snapshot.autoGain;
        d.softStopGainNode.gain.value = 1;
        d.crossfadeGainNode.gain.value = id === "A" ? gainA : gainB;

        // Dry path
        d.source.connect(d.autoGainNode);
        d.autoGainNode.connect(d.bassFilterNode);
        d.bassFilterNode.connect(d.hpfFilterNode);
        d.hpfFilterNode.connect(d.softStopGainNode);
        d.softStopGainNode.connect(d.crossfadeGainNode);
        d.crossfadeGainNode.connect(this.limiter);

        // Echo send (post softStop, pre crossfade so echo tail rings out naturally as dry fades)
        d.softStopGainNode.connect(d.echoSendNode);
        d.echoSendNode.connect(d.echoDelayNode);
        d.echoDelayNode.connect(d.echoFilterNode);
        d.echoFilterNode.connect(d.echoFeedbackNode);
        d.echoFeedbackNode.connect(d.echoDelayNode);
        d.echoFilterNode.connect(this.limiter);
      }
    }

    this.applyCrossfadeGains();
  }

  private isDeckAudible(id: DeckId): boolean {
    return id === "A" ? this.crossfade < 0.95 : this.crossfade > 0.05;
  }

  private ensureRafLoop(): void {
    if (this.rafTickId !== null) return;
    const tick = () => {
      let anyPlaying = false;
      let changed = false;

      for (const id of ["A", "B"] as const) {
        const d = this.decks[id];
        if (!d.audio.paused) {
          anyPlaying = true;
          const nextTime = d.audio.currentTime;
          if (Math.abs(nextTime - d.snapshot.currentTime) > 0.04) {
            d.snapshot = { ...d.snapshot, currentTime: nextTime };
            changed = true;
          }
        }
      }

      if (changed) this.emit();
      if (anyPlaying) {
        this.rafTickId = requestAnimationFrame(tick);
      } else {
        this.rafTickId = null;
      }
    };
    this.rafTickId = requestAnimationFrame(tick);
  }

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  getDeck(id: DeckId): DeckSnapshot {
    return this.decks[id].snapshot;
  }

  getCrossfade(): number {
    return this.crossfade;
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  getIsAutoFading(): boolean {
    return this.isAutoFading;
  }

  getMixMode(): MixMode {
    return this.mixMode;
  }

  setMixMode(mode: MixMode): void {
    if (this.mixMode === mode) return;
    this.mixMode = mode;
    this.emit();
  }

  setFadeBars(bars: FadeBars): void {
    this.fadeBars = bars;
  }

  /** True while any mix runs, including one the DJ is driving by hand. */
  getIsMixing(): boolean {
    return this.mix !== null || this.isAutoFading;
  }

  getActiveTransitionLabel(): string | null {
    return this.activeTransitionLabel;
  }

  getLastStartErrorMs(): number | null {
    return this.lastStartErrorMs;
  }

  private cancelPendingBeatWait(): void {
    if (this.pendingBeatTimerId !== null) {
      window.clearTimeout(this.pendingBeatTimerId);
      this.pendingBeatTimerId = null;
    }
    if (this.pendingBeatRafId !== null) {
      cancelAnimationFrame(this.pendingBeatRafId);
      this.pendingBeatRafId = null;
    }
  }

  private abortActiveFade(glideMs = 800): void {
    const wasActive =
      this.fadeRafId !== null ||
      this.pendingBeatTimerId !== null ||
      this.pendingBeatRafId !== null ||
      this.isAutoFading ||
      this.mix !== null;
    if (!wasActive) return;
    this.mix = null;

    this.fadeSeq++;
    this.cancelPendingBeatWait();
    if (this.fadeRafId !== null) {
      cancelAnimationFrame(this.fadeRafId);
      this.fadeRafId = null;
    }
    this.isAutoFading = false;
    this.activeTransitionLabel = null;
    analysisScheduler.setPausedForFade(false);
    this.resetDeckDsp("A", 0.03);
    this.resetDeckDsp("B", 0.03);
    this.glideTempoToNatural("A", glideMs);
    this.glideTempoToNatural("B", glideMs);
    this.applyCrossfadeGains();
    this.emit();
  }

  private resetDeckDsp(id: DeckId, timeConstant = 0.04): void {
    const d = this.decks[id];
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (d.bassFilterNode) {
      d.bassFilterNode.gain.setTargetAtTime(0, now, timeConstant);
    }
    if (d.hpfFilterNode) {
      d.hpfFilterNode.frequency.setTargetAtTime(20, now, timeConstant);
    }
    if (d.echoSendNode) {
      d.echoSendNode.gain.setTargetAtTime(0, now, timeConstant);
    }
  }

  private cancelTempoGlide(id: DeckId): void {
    const d = this.decks[id];
    if (d.tempoGlideRafId !== null) {
      cancelAnimationFrame(d.tempoGlideRafId);
      d.tempoGlideRafId = null;
    }
  }

  private glideTempoToNatural(id: DeckId, durationMs = 3500): void {
    const d = this.decks[id];
    this.cancelTempoGlide(id);
    const startRate = d.audio.playbackRate;
    if (Math.abs(startRate - 1) < 0.002) {
      d.audio.playbackRate = 1;
      return;
    }
    const startTime = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      const eased = 1 - (1 - t) * (1 - t);
      d.audio.playbackRate = startRate + (1 - startRate) * eased;
      if (t < 1 && !d.audio.paused) {
        d.tempoGlideRafId = requestAnimationFrame(step);
      } else {
        d.audio.playbackRate = 1;
        d.tempoGlideRafId = null;
      }
    };
    d.tempoGlideRafId = requestAnimationFrame(step);
  }

  async loadTrack(id: DeckId, track: TrackItem): Promise<void> {
    const d = this.decks[id];
    const seq = ++d.loadSeq;

    if (d.softStopTimerId !== null) {
      window.clearTimeout(d.softStopTimerId);
      d.softStopTimerId = null;
    }
    this.cancelTempoGlide(id);
    this.resetDeckDsp(id, 0.01);
    d.audio.pause();
    d.audio.playbackRate = 1;
    if (d.objectUrl) {
      URL.revokeObjectURL(d.objectUrl);
      d.objectUrl = null;
    }

    let srcUrl = "";
    if (track.file) {
      srcUrl = URL.createObjectURL(track.file);
      d.objectUrl = srcUrl;
    } else if (track.remoteUrl) {
      srcUrl = track.remoteUrl;
    }

    d.audio.src = srcUrl;
    d.audio.currentTime = 0;
    d.audio.volume = 1;
    if (d.autoGainNode && this.ctx) {
      d.autoGainNode.gain.setTargetAtTime(1, this.ctx.currentTime, 0.01);
    }

    const initialCues =
      track.cues && track.cues.version === TRACK_CUES_VERSION
        ? track.cues
        : null;

    d.snapshot = {
      track,
      isPlaying: false,
      currentTime: 0,
      duration: track.duration ?? 0,
      cues: initialCues,
      selectedEntryBar: initialCues ? initialCues.bestEntryBar : null,
      manualEntrySec: null,
      peaks: [],
      peaksLoading: true,
      autoGain: 1,
      bpm: track.bpm,
      waveformLocked: false,
    };
    this.emit();

    try {
      const arrayBuf = track.file
        ? await track.file.arrayBuffer()
        : track.remoteUrl
          ? await fetch(track.remoteUrl).then((r) => r.arrayBuffer())
          : null;
      if (!arrayBuf || d.loadSeq !== seq) return;
      // 22.05 kHz mono halves decode RAM & CPU while preserving waveform, loudness, and cue accuracy
      const offlineCtx = new OfflineAudioContext(1, 1, 22050);
      const audioBuf = await offlineCtx.decodeAudioData(arrayBuf);
      if (d.loadSeq !== seq) return;

      const channelData = audioBuf.getChannelData(0);
      const { peaks, autoGain } = computeWaveformAndAutoGain(channelData, 160);

      let cues = initialCues;
      let detectedBpm = track.bpm;
      if (!cues) {
        const cached = await analysisScheduler.getCachedAnalysis(track);
        if (d.loadSeq !== seq) return;
        if (cached) {
          cues = cached.cues;
          detectedBpm = detectedBpm ?? cached.bpm;
        } else {
          const analysis = await analysisScheduler.analyzeInWorker(
            channelData,
            audioBuf.sampleRate,
          );
          if (d.loadSeq !== seq) return;
          cues = analysis.cues;
          detectedBpm = detectedBpm ?? analysis.bpm;
          analysisScheduler.recordResult(
            track,
            detectedBpm,
            cues,
            audioBuf.duration,
          );
        }
      }

      const selectedEntryBar = d.snapshot.selectedEntryBar ?? cues.bestEntryBar;

      d.snapshot = {
        ...d.snapshot,
        duration: audioBuf.duration || d.snapshot.duration,
        cues,
        selectedEntryBar,
        peaks,
        peaksLoading: false,
        autoGain,
        bpm: detectedBpm,
      };
      if (d.autoGainNode && this.ctx) {
        d.autoGainNode.gain.setTargetAtTime(
          autoGain,
          this.ctx.currentTime,
          0.02,
        );
      }
      this.emit();
    } catch {
      if (d.loadSeq !== seq) return;
      d.snapshot = { ...d.snapshot, peaksLoading: false };
      this.emit();
    }
  }

  /** Empty a deck so the DJ (or the queue) chooses what goes there next. */
  unloadTrack(id: DeckId): void {
    const d = this.decks[id];
    d.loadSeq++;
    if (d.softStopTimerId !== null) {
      window.clearTimeout(d.softStopTimerId);
      d.softStopTimerId = null;
    }
    this.cancelTempoGlide(id);
    this.resetDeckDsp(id, 0.01);
    d.audio.pause();
    d.audio.playbackRate = 1;
    d.audio.removeAttribute("src");
    d.audio.load();
    if (d.objectUrl) {
      URL.revokeObjectURL(d.objectUrl);
      d.objectUrl = null;
    }
    if (d.softStopGainNode && this.ctx) {
      d.softStopGainNode.gain.setValueAtTime(1, this.ctx.currentTime);
    }
    d.snapshot = emptyDeck();
    this.emit();
  }

  async play(id: DeckId, resetDsp = true): Promise<boolean> {
    this.ensureAudioGraph();
    const d = this.decks[id];
    if (!d.snapshot.track) return false;

    if (d.softStopTimerId !== null) {
      window.clearTimeout(d.softStopTimerId);
      d.softStopTimerId = null;
    }

    if (resetDsp && !this.isAutoFading) {
      this.resetDeckDsp(id, 0.01);
    }

    if (d.softStopGainNode && this.ctx) {
      d.softStopGainNode.gain.cancelScheduledValues(this.ctx.currentTime);
      d.softStopGainNode.gain.setValueAtTime(1, this.ctx.currentTime);
    }
    if (d.audio.ended) {
      d.audio.currentTime = 0;
    }
    try {
      await d.audio.play();
      return true;
    } catch {
      return false;
    }
  }

  softStop(id: DeckId): void {
    const d = this.decks[id];
    if (d.audio.paused) return;

    this.abortActiveFade(800);

    if (d.softStopTimerId !== null) {
      window.clearTimeout(d.softStopTimerId);
      d.softStopTimerId = null;
    }

    if (d.softStopGainNode && this.ctx) {
      const now = this.ctx.currentTime;
      d.softStopGainNode.gain.cancelScheduledValues(now);
      d.softStopGainNode.gain.setValueAtTime(
        d.softStopGainNode.gain.value,
        now,
      );
      d.softStopGainNode.gain.linearRampToValueAtTime(0.0001, now + 0.35);
      d.softStopTimerId = window.setTimeout(() => {
        d.softStopTimerId = null;
        d.audio.pause();
        if (d.softStopGainNode && this.ctx) {
          d.softStopGainNode.gain.setValueAtTime(1, this.ctx.currentTime);
        }
      }, 360);
    } else {
      d.audio.pause();
    }
  }

  toggleWaveformLock(id: DeckId): void {
    const d = this.decks[id];
    d.snapshot = { ...d.snapshot, waveformLocked: !d.snapshot.waveformLocked };
    this.emit();
  }

  stepSelectedEntry(id: DeckId, delta: -1 | 1): void {
    const d = this.decks[id];
    const entries = d.snapshot.cues?.entries;
    if (!entries || entries.length === 0) {
      // No analysed entry phrases: step the cue position by one 8-bar phrase instead.
      const bpm = d.snapshot.bpm ?? d.snapshot.track?.bpm ?? null;
      this.seekBySeconds(id, (delta * barFadeDurationMs(bpm, 8)) / 1000);
      return;
    }

    const currentBar =
      d.snapshot.selectedEntryBar ?? d.snapshot.cues?.bestEntryBar ?? 0;
    const currIdx = Math.max(
      0,
      entries.findIndex((s) => s.bar === currentBar),
    );
    const nextIdx = Math.min(entries.length - 1, Math.max(0, currIdx + delta));
    const nextSpot = entries[nextIdx];
    if (!nextSpot || nextSpot.bar === d.snapshot.selectedEntryBar) return;

    d.snapshot = {
      ...d.snapshot,
      selectedEntryBar: nextSpot.bar,
      manualEntrySec: null,
    };
    // A deck pre-running muted follows its flag so a hand mix starts from it.
    if (!d.audio.paused && !this.isDeckAudible(id) && this.mix === null) {
      this.cueToSelectedEntry(id);
    }
    this.emit();
  }

  seek(id: DeckId, ratio: number): void {
    const d = this.decks[id];
    if (!d.snapshot.track) return;
    const dur = d.snapshot.duration || d.audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const clamped = Math.min(0.999, Math.max(0, ratio));
    d.audio.currentTime = clamped * dur;
    d.snapshot = {
      ...d.snapshot,
      currentTime: d.audio.currentTime,
      manualEntrySec: this.manualEntryAfterSeek(id, d.audio.currentTime),
    };
    this.emit();
  }

  seekBySeconds(id: DeckId, deltaSeconds: number): void {
    const d = this.decks[id];
    if (!d.snapshot.track) return;
    const dur = d.snapshot.duration || d.audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const next = Math.min(
      Math.max(0, d.audio.currentTime + deltaSeconds),
      Math.max(0, dur - 0.5),
    );
    d.audio.currentTime = next;
    d.snapshot = {
      ...d.snapshot,
      currentTime: next,
      manualEntrySec: this.manualEntryAfterSeek(id, next),
    };
    this.emit();
  }

  setCrossfade(value: number, fromUser = true): void {
    const prev = this.crossfade;
    this.crossfade = Math.min(1, Math.max(0, value));

    if (fromUser) {
      if (this.mix) {
        this.driveMixByHand(this.mix);
        return;
      }
      // Touching the fader while Fade to still waits for the bar line cancels it.
      if (this.isAutoFading) this.abortActiveFade(1200);
      else if (this.maybeStartHandMix(prev)) return;
    }

    this.applyCrossfadeGains();
    this.syncWaveformLocks();
    this.emit();
  }

  private syncWaveformLocks(): void {
    for (const id of ["A", "B"] as const) {
      const d = this.decks[id];
      if (d.snapshot.isPlaying) {
        d.snapshot = { ...d.snapshot, waveformLocked: this.isDeckAudible(id) };
      }
    }
  }

  private applyCrossfadeGains(): void {
    const { gainA, gainB } = equalPowerGains(this.crossfade);
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.decks.A.crossfadeGainNode) {
      this.decks.A.crossfadeGainNode.gain.setTargetAtTime(gainA, now, 0.015);
    }
    if (this.decks.B.crossfadeGainNode) {
      this.decks.B.crossfadeGainNode.gain.setTargetAtTime(gainB, now, 0.015);
    }
  }

  setMasterVolume(vol: number): void {
    this.masterVolume = Math.min(1, Math.max(0, vol));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(
        this.masterVolume,
        this.ctx.currentTime,
        0.015,
      );
    } else {
      this.applyCrossfadeGains();
    }
    this.emit();
  }

  private waitForOutgoingBarLine(
    seq: number,
    oldInternals: DeckInternals,
    targetBarSec: number,
    targetCtxTime: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const pollFine = () => {
        this.pendingBeatRafId = null;
        if (seq !== this.fadeSeq || oldInternals.audio.paused) {
          resolve(false);
          return;
        }
        const ctxNow = this.ctx?.currentTime ?? targetCtxTime;
        const remCtx = targetCtxTime - ctxNow;
        const remAudio = targetBarSec - oldInternals.audio.currentTime;
        if (remCtx <= 0.008 || remAudio <= 0.008) {
          resolve(true);
          return;
        }
        this.pendingBeatRafId = requestAnimationFrame(pollFine);
      };

      const ctxNow = this.ctx?.currentTime ?? targetCtxTime;
      const coarseMs = Math.max(0, (targetCtxTime - ctxNow - 0.04) * 1000);
      if (coarseMs > 8) {
        this.pendingBeatTimerId = window.setTimeout(() => {
          this.pendingBeatTimerId = null;
          if (seq !== this.fadeSeq || oldInternals.audio.paused) {
            resolve(false);
            return;
          }
          this.pendingBeatRafId = requestAnimationFrame(pollFine);
        }, coarseMs);
      } else {
        this.pendingBeatRafId = requestAnimationFrame(pollFine);
      }
    });
  }

  /** Works out how the idle deck should come in over the playing one. */
  private prepareMix(targetDeck: DeckId): PreparedMix | null {
    const oldDeck: DeckId = targetDeck === "A" ? "B" : "A";
    const oldInternals = this.decks[oldDeck];
    const targetInternals = this.decks[targetDeck];
    if (!targetInternals.snapshot.track) return null;

    const oldPlaying = !oldInternals.audio.paused;
    const oldCues = oldInternals.snapshot.cues;
    const targetCues = targetInternals.snapshot.cues;
    const oldGrid = oldPlaying ? (oldCues?.grid ?? null) : null;

    // The mix starts on the outgoing deck's next bar line (beat 1, <= 1 bar away).
    let targetBarSec: number | null = null;
    let waitSec = 0;
    if (oldGrid) {
      const outNowSec = oldInternals.audio.currentTime;
      targetBarSec = getNextBeatOneSec(oldGrid, outNowSec);
      const rate = oldInternals.audio.playbackRate || 1;
      waitSec = Math.max(0, (targetBarSec - outNowSec) / rate);
    }

    const selectedEntry =
      targetInternals.snapshot.manualEntrySec === null
        ? this.selectedEntrySpot(targetDeck)
        : null;

    const exitQuality =
      targetBarSec !== null
        ? getExitQualityAtTime(oldCues, targetBarSec)
        : oldCues
          ? (getActiveExitSpot(oldCues, oldInternals.audio.currentTime)
              ?.quality ?? null)
          : null;

    const combinedConfidence: "high" | "low" | undefined = !oldPlaying
      ? undefined
      : oldCues && targetCues
        ? oldCues.confidence === "high" &&
          targetCues.confidence === "high" &&
          oldCues.grid !== null &&
          targetCues.grid !== null
          ? "high"
          : "low"
        : oldCues?.confidence === "low" || targetCues?.confidence === "low"
          ? "low"
          : undefined;

    // If the outgoing deck isn't actually playing, do a clean classic bring-in
    const effectiveMode: MixMode = !oldPlaying ? "classic" : this.mixMode;

    const fromTempo = mixTempo(
      oldCues,
      oldInternals.snapshot.bpm ?? oldInternals.snapshot.track?.bpm ?? null,
    );
    const mixStartSec = targetBarSec ?? oldInternals.audio.currentTime;
    const oldDuration =
      oldInternals.snapshot.duration || oldInternals.audio.duration || 0;
    const plan = planMixTransition({
      mode: effectiveMode,
      barsAvailable:
        oldPlaying && oldDuration > 0
          ? (oldDuration - mixStartSec) /
            (barFadeDurationMs(fromTempo, 1) / 1000)
          : undefined,
      fromBpm: fromTempo,
      toBpm: mixTempo(
        targetCues,
        targetInternals.snapshot.bpm ??
          targetInternals.snapshot.track?.bpm ??
          null,
      ),
      fadeBars: this.fadeBars,
      confidence: combinedConfidence,
      exitQuality,
      entryQuality: selectedEntry?.quality ?? null,
      keyFit: keyFit(oldCues?.key ?? null, targetCues?.key ?? null),
    });

    const inGrid = targetCues?.grid ?? null;
    const lockGrids =
      plan.tempoMultiplier !== null && oldGrid && inGrid
        ? { outGrid: oldGrid, inGrid, tempoMultiplier: plan.tempoMultiplier }
        : null;

    return {
      oldDeck,
      targetDeck,
      plan,
      targetBarSec,
      waitSec,
      selectedEntry,
      lockGrids,
    };
  }

  private selectedEntrySpot(id: DeckId): CueSpot | null {
    const d = this.decks[id];
    const cues = d.snapshot.cues;
    return cues
      ? findCueSpot(
          cues.entries,
          d.snapshot.selectedEntryBar ?? cues.bestEntryBar,
        )
      : null;
  }

  /**
   * A seek on the idle deck is the DJ choosing where it comes in, so it replaces the
   * entry flag. A seek on the live deck keeps whatever entry was already chosen.
   */
  private manualEntryAfterSeek(id: DeckId, sec: number): number | null {
    const d = this.decks[id];
    const idle =
      !this.isDeckAudible(id) && this.mix === null && !this.isAutoFading;
    return idle ? sec : d.snapshot.manualEntrySec;
  }

  /** Moves a deck to its entry point: the hand-set position, else the flag (used before it is brought in). */
  cueToSelectedEntry(id: DeckId, leadSec = 0): void {
    const d = this.decks[id];
    const entrySec =
      d.snapshot.manualEntrySec ?? this.selectedEntrySpot(id)?.sec;
    if (entrySec === undefined) return;
    const dur = d.snapshot.duration || d.audio.duration || 0;
    if (entrySec < 0 || (dur > 0 && entrySec >= dur - 2)) return;
    const sec = Math.max(0, entrySec - leadSec);
    d.audio.currentTime = sec;
    d.snapshot = { ...d.snapshot, currentTime: sec };
  }

  /** Sets the incoming deck's tempo and DSP to the plan's starting point (no bass double-hit). */
  private armIncoming(prepared: PreparedMix): void {
    const oldInternals = this.decks[prepared.oldDeck];
    const targetInternals = this.decks[prepared.targetDeck];
    this.cancelTempoGlide(prepared.targetDeck);
    this.cancelTempoGlide(prepared.oldDeck);
    targetInternals.audio.playbackRate = prepared.plan.initialPlaybackRate;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (prepared.plan.echoDelaySec > 0 && oldInternals.echoDelayNode) {
      oldInternals.echoDelayNode.delayTime.setValueAtTime(
        prepared.plan.echoDelaySec,
        now,
      );
    }
    const initialDsp = computeTransitionDsp(
      prepared.plan.technique,
      0,
      prepared.plan.fadeBars,
    );
    if (targetInternals.bassFilterNode) {
      targetInternals.bassFilterNode.gain.setValueAtTime(
        initialDsp.incoming.bassDb,
        now,
      );
    }
    if (targetInternals.hpfFilterNode) {
      targetInternals.hpfFilterNode.frequency.setValueAtTime(
        initialDsp.incoming.hpfHz,
        now,
      );
    }
    if (targetInternals.echoSendNode) {
      targetInternals.echoSendNode.gain.setValueAtTime(0, now);
    }
  }

  private createMix(
    seq: number,
    prepared: PreparedMix,
    startVal: number,
    driver: MixDriver,
  ): ActiveMix {
    const startGains = equalPowerGains(startVal);
    return {
      seq,
      driver,
      oldDeck: prepared.oldDeck,
      targetDeck: prepared.targetDeck,
      plan: prepared.plan,
      lockGrids: prepared.lockGrids,
      startVal,
      endVal: prepared.targetDeck === "A" ? 0 : 1,
      startOutGain:
        prepared.oldDeck === "A" ? startGains.gainA : startGains.gainB,
      startInGain:
        prepared.targetDeck === "A" ? startGains.gainA : startGains.gainB,
      progress: 0,
      autoFromProgress: 0,
      autoStartedAt: 0,
      lastLockAt: performance.now(),
    };
  }

  /**
   * Starts a hand-driven mix when the DJ pulls the fader from the playing deck toward a
   * loaded idle deck. Returns true when it took over the fader move.
   */
  private maybeStartHandMix(prev: number): boolean {
    const towardB = this.crossfade > prev;
    const targetDeck: DeckId = towardB ? "B" : "A";
    const oldDeck: DeckId = towardB ? "A" : "B";
    const endVal = towardB ? 1 : 0;
    if (this.crossfade === prev || Math.abs(endVal - prev) < 0.2) return false;
    if (
      this.decks[oldDeck].audio.paused ||
      !this.decks[targetDeck].snapshot.track
    )
      return false;
    // The fader must come from the playing deck's side.
    if (towardB ? prev > 0.5 : prev < 0.5) return false;

    this.ensureAudioGraph();
    const prepared = this.prepareMix(targetDeck);
    if (!prepared) return false;

    this.fadeSeq++;
    const seq = this.fadeSeq;
    const targetInternals = this.decks[targetDeck];
    if (targetInternals.audio.paused) {
      // Start early by the time left to the next bar line so the entry lands on beat 1.
      const lead = prepared.lockGrids
        ? prepared.waitSec * prepared.plan.initialPlaybackRate
        : 0;
      this.cueToSelectedEntry(targetDeck, lead);
    }
    this.armIncoming(prepared);
    analysisScheduler.setPausedForFade(true);
    this.activeTransitionLabel = `Hand mix · ${prepared.plan.label}`;
    const mix = this.createMix(seq, prepared, prev, "hand");
    this.mix = mix;
    this.driveMixByHand(mix);
    this.ensureMixLoop();

    if (targetInternals.audio.paused) {
      void this.play(targetDeck, false).then((ok) => {
        if (!ok && this.mix?.seq === seq) this.abortActiveFade(400);
      });
    }
    return true;
  }

  /** Progress (0..1) whose eased fader position equals the current crossfade. */
  private handProgress(mix: ActiveMix): number {
    const span = mix.endVal - mix.startVal;
    const frac =
      span === 0
        ? 1
        : Math.min(1, Math.max(0, (this.crossfade - mix.startVal) / span));
    return frac < 0.5 ? Math.sqrt(frac / 2) : 1 - Math.sqrt((1 - frac) / 2);
  }

  private driveMixByHand(mix: ActiveMix): void {
    if (mix.driver === "auto") {
      // Grabbing the fader mid-fade hands the pace to the DJ; the technique carries on.
      mix.driver = "hand";
      this.isAutoFading = false;
      this.activeTransitionLabel = `Hand mix · ${mix.plan.label}`;
    }
    const t = this.handProgress(mix);
    if (t >= 1) {
      this.finishMix(mix);
      return;
    }
    if (t <= 0 && this.crossfade === mix.startVal && mix.progress > 0) {
      // Pulled all the way back: drop the mix and leave the incoming deck cued, muted.
      this.abortActiveFade(800);
      return;
    }
    this.applyMixProgress(mix, t);
    this.syncWaveformLocks();
    this.emit();
  }

  private applyMixProgress(mix: ActiveMix, t: number): void {
    mix.progress = t;
    if (!this.ctx) return;
    const oldInternals = this.decks[mix.oldDeck];
    const targetInternals = this.decks[mix.targetDeck];
    const audioNow = this.ctx.currentTime;
    const { outgoing, incoming } = computeTransitionDsp(
      mix.plan.technique,
      t,
      mix.plan.fadeBars,
    );
    const outGain = mix.startOutGain * outgoing.gain;
    const inGain = mix.startInGain + (1 - mix.startInGain) * incoming.gain;

    oldInternals.crossfadeGainNode?.gain.setTargetAtTime(
      outGain,
      audioNow,
      0.015,
    );
    oldInternals.bassFilterNode?.gain.setTargetAtTime(
      outgoing.bassDb,
      audioNow,
      0.02,
    );
    oldInternals.hpfFilterNode?.frequency.setTargetAtTime(
      outgoing.hpfHz,
      audioNow,
      0.025,
    );
    oldInternals.echoSendNode?.gain.setTargetAtTime(
      outgoing.echoSend,
      audioNow,
      0.015,
    );

    targetInternals.crossfadeGainNode?.gain.setTargetAtTime(
      inGain,
      audioNow,
      0.015,
    );
    targetInternals.bassFilterNode?.gain.setTargetAtTime(
      incoming.bassDb,
      audioNow,
      0.02,
    );
    targetInternals.hpfFilterNode?.frequency.setTargetAtTime(
      incoming.hpfHz,
      audioNow,
      0.02,
    );
    targetInternals.echoSendNode?.gain.setTargetAtTime(
      incoming.echoSend,
      audioNow,
      0.015,
    );
  }

  private finishMix(mix: ActiveMix): void {
    if (this.mix !== mix) return;
    const oldInternals = this.decks[mix.oldDeck];
    const targetInternals = this.decks[mix.targetDeck];
    this.mix = null;
    if (this.fadeRafId !== null) {
      cancelAnimationFrame(this.fadeRafId);
      this.fadeRafId = null;
    }
    this.isAutoFading = false;
    this.activeTransitionLabel = null;
    analysisScheduler.setPausedForFade(false);
    this.crossfade = mix.endVal;
    this.applyCrossfadeGains();
    this.resetDeckDsp(mix.targetDeck, 0.02);
    this.resetDeckDsp(mix.oldDeck, 0.04);
    oldInternals.audio.pause();
    oldInternals.audio.playbackRate = 1;
    if (targetInternals.audio.playbackRate !== 1) {
      this.glideTempoToNatural(mix.targetDeck, 3500);
    }
    targetInternals.snapshot = {
      ...targetInternals.snapshot,
      waveformLocked: true,
    };
    this.emit();
    this.onMixComplete?.(mix.oldDeck);
  }

  /** One frame loop per mix: the timer drives auto mixes; phase lock runs for both drivers. */
  private ensureMixLoop(): void {
    if (this.fadeRafId !== null) return;
    const step = (now: number) => {
      const mix = this.mix;
      if (!mix || mix.seq !== this.fadeSeq) {
        this.fadeRafId = null;
        return;
      }
      const oldInternals = this.decks[mix.oldDeck];
      const targetInternals = this.decks[mix.targetDeck];

      if (
        mix.lockGrids &&
        now - mix.lastLockAt >= PHASE_LOCK_INTERVAL_MS &&
        !oldInternals.audio.paused &&
        !targetInternals.audio.paused
      ) {
        mix.lastLockAt = now;
        targetInternals.audio.playbackRate = phaseLockRate({
          baseRate: mix.plan.initialPlaybackRate,
          ...mix.lockGrids,
          outTimeSec: oldInternals.audio.currentTime,
          outRate: oldInternals.audio.playbackRate || 1,
          inTimeSec: targetInternals.audio.currentTime,
        }).rate;
      }

      if (mix.driver === "auto") {
        const t = Math.min(
          1,
          mix.autoFromProgress +
            (now - mix.autoStartedAt) / mix.plan.durationMs,
        );
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        this.crossfade = mix.startVal + (mix.endVal - mix.startVal) * eased;
        this.applyMixProgress(mix, t);
        this.emit();
        if (t >= 1) {
          this.finishMix(mix);
          return;
        }
      }
      this.fadeRafId = requestAnimationFrame(step);
    };
    this.fadeRafId = requestAnimationFrame(step);
  }

  private runAutoDriver(mix: ActiveMix): void {
    mix.driver = "auto";
    mix.autoFromProgress = mix.progress;
    mix.autoStartedAt = performance.now();
    this.isAutoFading = true;
    this.activeTransitionLabel = mix.plan.label;
    this.emit();
    this.ensureMixLoop();
  }

  async startAutoFade(targetDeck: DeckId): Promise<boolean> {
    // A hand mix toward the same deck: the timer takes over from where the fader is.
    if (this.mix && this.mix.targetDeck === targetDeck) {
      this.runAutoDriver(this.mix);
      return true;
    }

    this.fadeSeq++;
    const seq = this.fadeSeq;
    this.cancelPendingBeatWait();
    if (this.fadeRafId !== null) {
      cancelAnimationFrame(this.fadeRafId);
      this.fadeRafId = null;
    }
    if (this.mix) {
      this.mix = null;
      this.resetDeckDsp("A", 0.02);
      this.resetDeckDsp("B", 0.02);
    }

    this.ensureAudioGraph();
    const prepared = this.prepareMix(targetDeck);
    if (!prepared) return false;
    const oldInternals = this.decks[prepared.oldDeck];
    const targetInternals = this.decks[targetDeck];

    // Seek the incoming deck to its chosen entry BEFORE the beat-1 wait,
    // even if it is already running silently: the selected entry is the DJ's choice.
    this.cueToSelectedEntry(targetDeck);

    this.cancelTempoGlide(targetDeck);
    this.cancelTempoGlide(prepared.oldDeck);
    analysisScheduler.setPausedForFade(true);
    this.isAutoFading = true;
    this.activeTransitionLabel = prepared.plan.label;
    this.emit();

    const { targetBarSec, waitSec } = prepared;
    const bail = (): false => {
      if (seq === this.fadeSeq) {
        targetInternals.audio.playbackRate = 1;
        this.resetDeckDsp(targetDeck, 0.02);
        this.isAutoFading = false;
        this.activeTransitionLabel = null;
        analysisScheduler.setPausedForFade(false);
        this.emit();
      }
      return false;
    };

    if (targetBarSec !== null && waitSec > 0.025 && this.ctx) {
      const targetCtxTime = this.ctx.currentTime + waitSec;
      const reachedBeat = await this.waitForOutgoingBarLine(
        seq,
        oldInternals,
        targetBarSec,
        targetCtxTime,
      );
      if (!reachedBeat || seq !== this.fadeSeq) return bail();
    }
    if (seq !== this.fadeSeq) return false;

    this.armIncoming(prepared);
    const started = await this.play(targetDeck, false);
    if (!started || seq !== this.fadeSeq) return bail();

    this.lastStartErrorMs =
      targetBarSec !== null
        ? Math.round(
            Math.abs(oldInternals.audio.currentTime - targetBarSec) * 1000,
          )
        : null;

    const mix = this.createMix(seq, prepared, this.crossfade, "auto");
    this.mix = mix;
    this.runAutoDriver(mix);
    return true;
  }
}

type MixDriver = "auto" | "hand";

interface PreparedMix {
  oldDeck: DeckId;
  targetDeck: DeckId;
  plan: TransitionPlan;
  targetBarSec: number | null;
  waitSec: number;
  selectedEntry: CueSpot | null;
  lockGrids: {
    outGrid: BeatGrid;
    inGrid: BeatGrid;
    tempoMultiplier: number;
  } | null;
}

interface ActiveMix {
  seq: number;
  driver: MixDriver;
  oldDeck: DeckId;
  targetDeck: DeckId;
  plan: TransitionPlan;
  lockGrids: PreparedMix["lockGrids"];
  startVal: number;
  endVal: number;
  startOutGain: number;
  startInGain: number;
  /** Mix progress 0..1 (the DSP curves' input). */
  progress: number;
  autoFromProgress: number;
  autoStartedAt: number;
  lastLockAt: number;
}

export const djEngine = new DjAudioEngine();
