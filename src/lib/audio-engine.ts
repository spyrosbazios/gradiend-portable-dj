import {
  computeTransitionDsp,
  computeWaveformAndAutoGain,
  equalPowerGains,
  findCueSpot,
  getActiveExitSpot,
  getExitQualityAtTime,
  getNextBeatOneSec,
  planMixTransition,
  TRACK_CUES_VERSION,
  type DeckId,
  type MixMode,
  type TrackCues,
} from "@/core/dj-math";
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
    peaks: [],
    peaksLoading: false,
    autoGain: 1,
    bpm: null,
    waveformLocked: false,
  };
}

export class DjAudioEngine {
  private ctx: AudioContext | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private decks: Record<DeckId, DeckInternals>;
  private crossfade = 0; // 0 = full A, 1 = full B
  private masterVolume = 0.85;
  private mixMode: MixMode = "smart";
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
        internals.snapshot = { ...internals.snapshot, duration: audio.duration };
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
      this.isAutoFading;
    if (!wasActive) return;

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
      track.cues && track.cues.version === TRACK_CUES_VERSION ? track.cues : null;

    d.snapshot = {
      track,
      isPlaying: false,
      currentTime: 0,
      duration: track.duration ?? 0,
      cues: initialCues,
      selectedEntryBar: initialCues ? initialCues.bestEntryBar : null,
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
          analysisScheduler.recordResult(track, detectedBpm, cues, audioBuf.duration);
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
        d.autoGainNode.gain.setTargetAtTime(autoGain, this.ctx.currentTime, 0.02);
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
      d.softStopGainNode.gain.setValueAtTime(d.softStopGainNode.gain.value, now);
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
    if (!entries || entries.length === 0) return;

    const currentBar = d.snapshot.selectedEntryBar ?? d.snapshot.cues?.bestEntryBar ?? 0;
    const currIdx = Math.max(
      0,
      entries.findIndex((s) => s.bar === currentBar),
    );
    const nextIdx = Math.min(entries.length - 1, Math.max(0, currIdx + delta));
    const nextSpot = entries[nextIdx];
    if (!nextSpot || nextSpot.bar === d.snapshot.selectedEntryBar) return;

    d.snapshot = { ...d.snapshot, selectedEntryBar: nextSpot.bar };
    this.emit();
  }

  seek(id: DeckId, ratio: number): void {
    const d = this.decks[id];
    if (!d.snapshot.track) return;
    const dur = d.snapshot.duration || d.audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const clamped = Math.min(0.999, Math.max(0, ratio));
    d.audio.currentTime = clamped * dur;
    d.snapshot = { ...d.snapshot, currentTime: d.audio.currentTime };
    this.emit();
  }

  seekBySeconds(id: DeckId, deltaSeconds: number): void {
    const d = this.decks[id];
    if (!d.snapshot.track) return;
    const dur = d.snapshot.duration || d.audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const next = Math.min(Math.max(0, d.audio.currentTime + deltaSeconds), Math.max(0, dur - 0.5));
    d.audio.currentTime = next;
    d.snapshot = { ...d.snapshot, currentTime: next };
    this.emit();
  }

  setCrossfade(value: number, fromUser = true): void {
    if (fromUser && this.isAutoFading) {
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
      this.glideTempoToNatural("A", 1200);
      this.glideTempoToNatural("B", 1200);
    }
    this.crossfade = Math.min(1, Math.max(0, value));
    this.applyCrossfadeGains();

    for (const id of ["A", "B"] as const) {
      const d = this.decks[id];
      if (d.snapshot.isPlaying) {
        d.snapshot = { ...d.snapshot, waveformLocked: this.isDeckAudible(id) };
      }
    }
    this.emit();
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
      this.masterGain.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.015);
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

  async startAutoFade(
    targetDeck: DeckId,
    durationMs = 5000,
    onComplete?: (finishedOldDeck: DeckId) => void,
    modeOverride?: MixMode,
  ): Promise<boolean> {
    this.fadeSeq++;
    const seq = this.fadeSeq;
    this.cancelPendingBeatWait();
    if (this.fadeRafId !== null) {
      cancelAnimationFrame(this.fadeRafId);
      this.fadeRafId = null;
      this.resetDeckDsp("A", 0.02);
      this.resetDeckDsp("B", 0.02);
    }

    const oldDeck: DeckId = targetDeck === "A" ? "B" : "A";
    const oldInternals = this.decks[oldDeck];
    const targetInternals = this.decks[targetDeck];
    if (!targetInternals.snapshot.track) return false;

    this.ensureAudioGraph();

    const oldPlaying = !oldInternals.audio.paused;
    const oldCues = oldInternals.snapshot.cues;
    const targetCues = targetInternals.snapshot.cues;
    const oldGrid = oldPlaying ? (oldCues?.grid ?? null) : null;

    // Schedule start on the outgoing deck's next bar line (beat 1, <= 1 bar wait)
    let targetBarSec: number | null = null;
    let waitSec = 0;
    if (oldGrid) {
      const outNowSec = oldInternals.audio.currentTime;
      targetBarSec = getNextBeatOneSec(oldGrid, outNowSec);
      const rate = oldInternals.audio.playbackRate || 1;
      waitSec = Math.max(0, (targetBarSec - outNowSec) / rate);
    }

    const selectedEntry = targetCues
      ? findCueSpot(
          targetCues.entries,
          targetInternals.snapshot.selectedEntryBar ?? targetCues.bestEntryBar,
        )
      : null;

    const exitQuality =
      targetBarSec !== null
        ? getExitQualityAtTime(oldCues, targetBarSec)
        : oldCues
          ? (getActiveExitSpot(oldCues, oldInternals.audio.currentTime)?.quality ?? null)
          : null;
    const entryQuality = selectedEntry?.quality ?? null;

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
    const effectiveMode: MixMode = !oldPlaying ? "classic" : (modeOverride ?? this.mixMode);

    const plan = planMixTransition({
      mode: effectiveMode,
      fromBpm: oldInternals.snapshot.bpm ?? oldInternals.snapshot.track?.bpm ?? null,
      toBpm: targetInternals.snapshot.bpm ?? targetInternals.snapshot.track?.bpm ?? null,
      baseDurationMs: durationMs,
      confidence: combinedConfidence,
      exitQuality,
      entryQuality,
    });

    // Seek incoming deck to its chosen entry phrase cue BEFORE the beat-1 timer fires,
    // even if it is already running silently: the selected entry is the DJ's choice.
    const targetDur = targetInternals.snapshot.duration || targetInternals.audio.duration || 0;
    if (
      selectedEntry &&
      selectedEntry.sec >= 0 &&
      (targetDur === 0 || selectedEntry.sec < targetDur - 2)
    ) {
      targetInternals.audio.currentTime = selectedEntry.sec;
      targetInternals.snapshot = {
        ...targetInternals.snapshot,
        currentTime: selectedEntry.sec,
      };
    }

    this.cancelTempoGlide(targetDeck);
    this.cancelTempoGlide(oldDeck);
    analysisScheduler.setPausedForFade(true);
    this.isAutoFading = true;
    this.activeTransitionLabel = plan.label;
    this.emit();

    if (targetBarSec !== null && waitSec > 0.025 && this.ctx) {
      const targetCtxTime = this.ctx.currentTime + waitSec;
      const reachedBeat = await this.waitForOutgoingBarLine(
        seq,
        oldInternals,
        targetBarSec,
        targetCtxTime,
      );
      if (!reachedBeat || seq !== this.fadeSeq) {
        if (seq === this.fadeSeq) {
          this.isAutoFading = false;
          this.activeTransitionLabel = null;
          analysisScheduler.setPausedForFade(false);
          this.emit();
        }
        return false;
      }
    }

    if (seq !== this.fadeSeq) return false;

    const startVal = this.crossfade;
    const endVal = targetDeck === "A" ? 0 : 1;

    targetInternals.audio.playbackRate = plan.initialPlaybackRate;

    // Prepare initial DSP state immediately so beat 1 starts cleanly (no bass double-hit!)
    if (this.ctx) {
      const now = this.ctx.currentTime;
      if (plan.echoDelaySec > 0 && oldInternals.echoDelayNode) {
        oldInternals.echoDelayNode.delayTime.setValueAtTime(plan.echoDelaySec, now);
      }
      const initialDsp = computeTransitionDsp(plan.technique, 0);
      if (targetInternals.bassFilterNode) {
        targetInternals.bassFilterNode.gain.setValueAtTime(initialDsp.incoming.bassDb, now);
      }
      if (targetInternals.hpfFilterNode) {
        targetInternals.hpfFilterNode.frequency.setValueAtTime(initialDsp.incoming.hpfHz, now);
      }
      if (targetInternals.echoSendNode) {
        targetInternals.echoSendNode.gain.setValueAtTime(0, now);
      }
    }

    const started = await this.play(targetDeck, false);
    if (!started || seq !== this.fadeSeq) {
      if (seq === this.fadeSeq) {
        targetInternals.audio.playbackRate = 1;
        this.resetDeckDsp(targetDeck, 0.02);
        this.isAutoFading = false;
        this.activeTransitionLabel = null;
        analysisScheduler.setPausedForFade(false);
        this.emit();
      }
      return false;
    }

    this.lastStartErrorMs =
      targetBarSec !== null
        ? Math.round(Math.abs(oldInternals.audio.currentTime - targetBarSec) * 1000)
        : null;

    const startTime = performance.now();
    const fadeDurationMs = plan.durationMs;
    const startGains = equalPowerGains(startVal);
    const startOutGain = oldDeck === "A" ? startGains.gainA : startGains.gainB;
    const startInGain = targetDeck === "A" ? startGains.gainA : startGains.gainB;

    const step = (now: number) => {
      if (seq !== this.fadeSeq) return;
      const t = Math.min(1, (now - startTime) / fadeDurationMs);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.crossfade = startVal + (endVal - startVal) * eased;

      if (this.ctx) {
        const audioNow = this.ctx.currentTime;
        const { outgoing, incoming } = computeTransitionDsp(plan.technique, t);
        const outGain = startOutGain * outgoing.gain;
        const inGain = startInGain + (1 - startInGain) * incoming.gain;

        if (oldInternals.crossfadeGainNode) {
          oldInternals.crossfadeGainNode.gain.setTargetAtTime(outGain, audioNow, 0.015);
        }
        if (oldInternals.bassFilterNode) {
          oldInternals.bassFilterNode.gain.setTargetAtTime(outgoing.bassDb, audioNow, 0.02);
        }
        if (oldInternals.hpfFilterNode) {
          oldInternals.hpfFilterNode.frequency.setTargetAtTime(outgoing.hpfHz, audioNow, 0.025);
        }
        if (oldInternals.echoSendNode) {
          oldInternals.echoSendNode.gain.setTargetAtTime(outgoing.echoSend, audioNow, 0.015);
        }

        if (targetInternals.crossfadeGainNode) {
          targetInternals.crossfadeGainNode.gain.setTargetAtTime(inGain, audioNow, 0.015);
        }
        if (targetInternals.bassFilterNode) {
          targetInternals.bassFilterNode.gain.setTargetAtTime(incoming.bassDb, audioNow, 0.02);
        }
        if (targetInternals.hpfFilterNode) {
          targetInternals.hpfFilterNode.frequency.setTargetAtTime(incoming.hpfHz, audioNow, 0.02);
        }
        if (targetInternals.echoSendNode) {
          targetInternals.echoSendNode.gain.setTargetAtTime(incoming.echoSend, audioNow, 0.015);
        }
      }

      this.emit();

      if (t < 1) {
        this.fadeRafId = requestAnimationFrame(step);
      } else {
        this.fadeRafId = null;
        this.isAutoFading = false;
        this.activeTransitionLabel = null;
        analysisScheduler.setPausedForFade(false);
        this.crossfade = endVal;
        this.applyCrossfadeGains();
        this.resetDeckDsp(targetDeck, 0.02);
        this.resetDeckDsp(oldDeck, 0.04);
        oldInternals.audio.pause();
        oldInternals.audio.playbackRate = 1;
        if (plan.initialPlaybackRate !== 1) {
          this.glideTempoToNatural(targetDeck, 3500);
        }
        targetInternals.snapshot = {
          ...targetInternals.snapshot,
          waveformLocked: true,
        };
        this.emit();
        onComplete?.(oldDeck);
      }
    };

    this.fadeRafId = requestAnimationFrame(step);
    return true;
  }
}

export const djEngine = new DjAudioEngine();
