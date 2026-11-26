import {
  computeWaveformAndAutoGain,
  detectAudibleBounds,
  equalPowerGains,
  estimateBpm,
  type DeckId,
} from "@/core/dj-math";

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
  coverUrl: string | null;
  metadataLoaded: boolean;
}

export interface DeckSnapshot {
  track: TrackItem | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  cueInSec: number;
  cueOutSec: number;
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
  crossfadeGainNode: GainNode | null;
  softStopGainNode: GainNode | null;
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
    cueInSec: 0,
    cueOutSec: 0,
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
  private fadeRafId: number | null = null;
  private isAutoFading = false;
  private listeners = new Set<EngineListener>();
  private rafTickId: number | null = null;

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

    const internals: DeckInternals = {
      audio,
      source: null,
      autoGainNode: null,
      crossfadeGainNode: null,
      softStopGainNode: null,
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
      internals.snapshot = {
        ...internals.snapshot,
        isPlaying: false,
        currentTime: internals.snapshot.duration,
        waveformLocked: false,
      };
      this.emit();
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
        d.softStopGainNode = this.ctx.createGain();
        d.crossfadeGainNode = this.ctx.createGain();

        const { gainA, gainB } = equalPowerGains(this.crossfade);
        d.autoGainNode.gain.value = d.snapshot.autoGain;
        d.softStopGainNode.gain.value = 1;
        d.crossfadeGainNode.gain.value = id === "A" ? gainA : gainB;

        d.source.connect(d.autoGainNode);
        d.autoGainNode.connect(d.softStopGainNode);
        d.softStopGainNode.connect(d.crossfadeGainNode);
        d.crossfadeGainNode.connect(this.limiter);
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

  async loadTrack(id: DeckId, track: TrackItem): Promise<void> {
    const d = this.decks[id];
    const seq = ++d.loadSeq;

    d.audio.pause();
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

    d.snapshot = {
      track,
      isPlaying: false,
      currentTime: 0,
      duration: track.duration ?? 0,
      cueInSec: 2.5,
      cueOutSec: track.duration ?? 0,
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
      const offlineCtx = new OfflineAudioContext(1, 1, 44100);
      const audioBuf = await offlineCtx.decodeAudioData(arrayBuf.slice(0));
      if (d.loadSeq !== seq) return;

      const channelData = audioBuf.getChannelData(0);
      const { peaks, autoGain } = computeWaveformAndAutoGain(channelData, 160);
      const detectedBpm = track.bpm ?? estimateBpm(channelData, audioBuf.sampleRate);
      const { cueInSec, cueOutSec } = detectAudibleBounds(
        channelData,
        audioBuf.sampleRate,
        2.5,
      );

      d.snapshot = {
        ...d.snapshot,
        duration: audioBuf.duration || d.snapshot.duration,
        cueInSec,
        cueOutSec,
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

  async play(id: DeckId): Promise<void> {
    this.ensureAudioGraph();
    const d = this.decks[id];
    if (!d.snapshot.track) return;

    if (d.softStopGainNode && this.ctx) {
      d.softStopGainNode.gain.cancelScheduledValues(this.ctx.currentTime);
      d.softStopGainNode.gain.setValueAtTime(1, this.ctx.currentTime);
    }
    if (d.audio.ended) {
      d.audio.currentTime = 0;
    }
    await d.audio.play();
  }

  softStop(id: DeckId): void {
    const d = this.decks[id];
    if (d.audio.paused) return;

    if (d.softStopGainNode && this.ctx) {
      const now = this.ctx.currentTime;
      d.softStopGainNode.gain.cancelScheduledValues(now);
      d.softStopGainNode.gain.setValueAtTime(d.softStopGainNode.gain.value, now);
      d.softStopGainNode.gain.linearRampToValueAtTime(0.0001, now + 0.35);
      window.setTimeout(() => {
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
    if (fromUser && this.fadeRafId !== null) {
      cancelAnimationFrame(this.fadeRafId);
      this.fadeRafId = null;
      this.isAutoFading = false;
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

  async startAutoFade(
    targetDeck: DeckId,
    durationMs = 5000,
    onComplete?: (finishedOldDeck: DeckId) => void,
  ): Promise<void> {
    if (this.fadeRafId !== null) {
      cancelAnimationFrame(this.fadeRafId);
      this.fadeRafId = null;
    }

    const oldDeck: DeckId = targetDeck === "A" ? "B" : "A";
    const startVal = this.crossfade;
    const endVal = targetDeck === "A" ? 0 : 1;

    // If the incoming deck hasn't been manually scrubbed and is sitting at 0:00,
    // jump past the silent/slow intro (~2.5s+ or first audible energy) before fading in
    const targetInternals = this.decks[targetDeck];
    const targetDur = targetInternals.snapshot.duration || targetInternals.audio.duration || 0;
    if (
      targetInternals.audio.paused &&
      targetInternals.audio.currentTime < 0.5 &&
      targetInternals.snapshot.cueInSec > 0 &&
      (targetDur === 0 || targetInternals.snapshot.cueInSec < targetDur - 5)
    ) {
      targetInternals.audio.currentTime = targetInternals.snapshot.cueInSec;
      targetInternals.snapshot = {
        ...targetInternals.snapshot,
        currentTime: targetInternals.snapshot.cueInSec,
      };
    }

    await this.play(targetDeck);

    this.isAutoFading = true;
    this.emit();

    const startTime = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.crossfade = startVal + (endVal - startVal) * eased;
      this.applyCrossfadeGains();
      this.emit();

      if (t < 1) {
        this.fadeRafId = requestAnimationFrame(step);
      } else {
        this.fadeRafId = null;
        this.isAutoFading = false;
        this.decks[oldDeck].audio.pause();
        this.decks[targetDeck].snapshot = {
          ...this.decks[targetDeck].snapshot,
          waveformLocked: true,
        };
        this.emit();
        onComplete?.(oldDeck);
      }
    };

    this.fadeRafId = requestAnimationFrame(step);
  }
}

export const djEngine = new DjAudioEngine();
