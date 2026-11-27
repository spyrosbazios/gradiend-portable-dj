import { get, set } from "idb-keyval";
import { analyzeTrackCues, TRACK_CUES_VERSION, type TrackCues } from "@/core/dj-math";
import type { TrackItem } from "@/lib/audio-engine";
import type { AnalysisWorkerResponse } from "@/lib/analysis.worker";
import { cacheKeyForTrack, isValidCachedCues, type CachedMeta } from "@/lib/library-loader";

export type AnalysisPriority = "high" | "queued" | "medium" | "low";

export interface TrackAnalysisResult {
  bpm: number | null;
  cues: TrackCues;
}

interface QueueJob {
  track: TrackItem;
  priority: AnalysisPriority;
  order: number;
}

type AnalysisResultCallback = (trackId: string, bpm: number | null, cues: TrackCues) => void;

const PRIORITY_RANK: Record<AnalysisPriority, number> = {
  high: 0,
  queued: 1,
  medium: 2,
  low: 3,
};

class AnalysisWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, (result: TrackAnalysisResult | null) => void>();

  private resetWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const resolve of this.pending.values()) {
      resolve(null);
    }
    this.pending.clear();
  }

  private ensureWorker(): Worker | null {
    if (typeof Worker === "undefined") return null;
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), {
          type: "module",
        });
        this.worker.addEventListener("message", (e: MessageEvent<AnalysisWorkerResponse>) => {
          const resolve = this.pending.get(e.data.id);
          if (resolve) {
            this.pending.delete(e.data.id);
            resolve({ bpm: e.data.bpm, cues: e.data.cues });
          }
        });
        this.worker.addEventListener("error", () => {
          this.resetWorker();
        });
        this.worker.addEventListener("messageerror", () => {
          this.resetWorker();
        });
      } catch {
        this.worker = null;
        return null;
      }
    }
    return this.worker;
  }

  analyze(channelData: Float32Array, sampleRate: number): Promise<TrackAnalysisResult> {
    if (sampleRate <= 0 || channelData.length === 0) {
      return Promise.resolve(analyzeTrackCues(channelData, sampleRate));
    }

    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve(analyzeTrackCues(channelData, sampleRate));
    }

    // Copy into a transferable buffer so we never detach AudioBuffer's internal storage
    const copy = channelData.slice();
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, (res) => {
        resolve(res ?? analyzeTrackCues(channelData, sampleRate));
      });
      try {
        worker.postMessage({ id, samples: copy, sampleRate }, [copy.buffer]);
      } catch {
        this.pending.delete(id);
        resolve(analyzeTrackCues(channelData, sampleRate));
      }
    });
  }
}

function yieldIdle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 16) {
      window.setTimeout(resolve, ms);
      return;
    }
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => window.setTimeout(resolve, ms), { timeout: 300 });
    } else {
      window.setTimeout(resolve, ms);
    }
  });
}

function needsAnalysis(track: TrackItem): boolean {
  return track.cues === null || track.cues.version !== TRACK_CUES_VERSION;
}

export class AnalysisScheduler {
  private queue: QueueJob[] = [];
  private queuedMap = new Map<string, QueueJob>();
  private completedIds = new Set<string>();
  private running = false;
  private generation = 0;
  private pauseUntilTs = 0;
  private pausedForFade = false;
  private activeAbort: { priority: AnalysisPriority; controller: AbortController } | null = null;
  private workerClient = new AnalysisWorkerClient();
  private onResult: AnalysisResultCallback | null = null;

  setListener(cb: AnalysisResultCallback | null): void {
    this.onResult = cb;
  }

  /**
   * Computes BPM and transition cues off the main thread in the shared Web Worker.
   */
  analyzeInWorker(channelData: Float32Array, sampleRate: number): Promise<TrackAnalysisResult> {
    return this.workerClient.analyze(channelData, sampleRate);
  }

  /**
   * Reads cached BPM + cues from IndexedDB if the stored cue version matches the current schema.
   */
  async getCachedAnalysis(track: TrackItem): Promise<TrackAnalysisResult | null> {
    try {
      const cached = await get<CachedMeta>(cacheKeyForTrack(track));
      if (cached && isValidCachedCues(cached.cues)) {
        return {
          bpm: cached.bpm ?? track.bpm,
          cues: cached.cues,
        };
      }
    } catch {
      // ignore cache read errors
    }
    return null;
  }

  /**
   * Records analysis results already computed during deck loading so background scanning
   * never decodes the same file twice and caches them to IndexedDB immediately.
   */
  recordResult(
    track: TrackItem,
    bpm: number | null,
    cues: TrackCues,
    duration?: number,
  ): void {
    this.completedIds.add(track.id);
    if (this.queuedMap.has(track.id)) {
      this.queuedMap.delete(track.id);
      this.queue = this.queue.filter((j) => j.track.id !== track.id);
    }
    this.onResult?.(track.id, bpm, cues);
    const key = cacheKeyForTrack(track);
    void (async () => {
      try {
        const existing = await get<CachedMeta>(key);
        await set(key, {
          title: existing?.title ?? track.title,
          artist: existing?.artist ?? track.artist,
          duration: existing?.duration ?? duration ?? track.duration,
          bpm: bpm ?? existing?.bpm ?? track.bpm,
          cues,
          coverUrl: existing?.coverUrl ?? track.coverUrl,
        } satisfies CachedMeta);
      } catch {
        // ignore quota errors
      }
    })();
  }

  /**
   * Pauses background decoding during active crossfades so zero audio-decode
   * spikes compete with a live Smart Mix transition.
   */
  setPausedForFade(paused: boolean): void {
    this.pausedForFade = paused;
    if (paused && this.activeAbort?.priority === "low") {
      this.activeAbort.controller.abort();
    }
  }

  /**
   * Briefly pauses background decoding while the user is actively rapid-scrolling.
   */
  notifyScrollActivity(cooldownMs = 220): void {
    this.pauseUntilTs = Math.max(this.pauseUntilTs, performance.now() + cooldownMs);
    if (this.activeAbort?.priority === "low") {
      this.activeAbort.controller.abort();
    }
  }

  reset(): void {
    this.generation++;
    this.activeAbort?.controller.abort();
    this.activeAbort = null;
    this.queue = [];
    this.queuedMap.clear();
    this.completedIds.clear();
  }

  /**
   * Immediately focuses analysis on the currently selected song and its closest
   * neighbors (alternating +1, -1, +2, -2...), demoting any stale focus jobs
   * from earlier scroll positions so fast scrolling never backs up.
   */
  setFocusWindow(selected: TrackItem, neighbors: TrackItem[]): void {
    for (const job of this.queue) {
      if (job.priority === "high" || job.priority === "medium") {
        job.priority = "low";
        job.order = 1000;
      }
    }

    let promoted = false;
    if (needsAnalysis(selected) && !this.completedIds.has(selected.id)) {
      this.upsertJob(selected, "high", 0);
      promoted = true;
    }

    for (let i = 0; i < neighbors.length; i++) {
      const neighbor = neighbors[i];
      if (!neighbor || !needsAnalysis(neighbor) || this.completedIds.has(neighbor.id)) continue;
      this.upsertJob(neighbor, "medium", i + 1);
      promoted = true;
    }

    if (promoted) {
      this.sortQueue();
      if (this.activeAbort?.priority === "low") {
        this.activeAbort.controller.abort();
      }
      if (!this.running) {
        void this.runLoop(this.generation);
      }
    }
  }

  enqueue(track: TrackItem, priority: AnalysisPriority): void {
    if (!needsAnalysis(track) || this.completedIds.has(track.id)) return;
    this.upsertJob(track, priority, priority === "high" ? 0 : 10);
    this.sortQueue();
    if (!this.running) {
      void this.runLoop(this.generation);
    }
  }

  enqueueMany(tracks: TrackItem[], priority: AnalysisPriority): void {
    let added = false;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (!track || !needsAnalysis(track) || this.completedIds.has(track.id)) continue;
      this.upsertJob(track, priority, 100 + i);
      added = true;
    }
    if (added) {
      this.sortQueue();
      if (!this.running) {
        void this.runLoop(this.generation);
      }
    }
  }

  private upsertJob(track: TrackItem, priority: AnalysisPriority, order: number): void {
    const existing = this.queuedMap.get(track.id);
    if (existing) {
      if (
        PRIORITY_RANK[priority] < PRIORITY_RANK[existing.priority] ||
        (priority === existing.priority && order < existing.order)
      ) {
        existing.priority = priority;
        existing.order = order;
      }
      return;
    }
    const job: QueueJob = { track, priority, order };
    this.queuedMap.set(track.id, job);
    this.queue.push(job);
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      return rankDiff !== 0 ? rankDiff : a.order - b.order;
    });
  }

  private async runLoop(gen: number): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length > 0 && this.generation === gen) {
        if (this.pausedForFade) {
          await yieldIdle(250);
          continue;
        }
        const waitMs = this.pauseUntilTs - performance.now();
        if (waitMs > 0) {
          await yieldIdle(Math.min(waitMs, 250));
          continue;
        }

        const job = this.queue.shift();
        if (!job) break;
        this.queuedMap.delete(job.track.id);

        if (this.completedIds.has(job.track.id)) continue;

        const controller = new AbortController();
        this.activeAbort = { priority: job.priority, controller };
        const result = await this.analyzeOne(job.track, controller.signal);
        this.activeAbort = null;

        if (this.generation !== gen) break;

        if (result === "aborted") {
          this.upsertJob(job.track, "low", 1000);
          this.sortQueue();
          continue;
        }

        this.completedIds.add(job.track.id);
        if (result !== null) {
          this.onResult?.(job.track.id, result.bpm, result.cues);
        }

        const delayMs =
          job.priority === "high" || job.priority === "queued"
            ? 12
            : job.priority === "medium"
              ? 24
              : 350;
        await yieldIdle(delayMs);
      }
    } finally {
      this.running = false;
    }
  }

  private async analyzeOne(
    track: TrackItem,
    signal: AbortSignal,
  ): Promise<TrackAnalysisResult | null | "aborted"> {
    const key = cacheKeyForTrack(track);
    try {
      const cached = await get<CachedMeta>(key);
      if (cached && isValidCachedCues(cached.cues)) {
        return { bpm: cached.bpm ?? track.bpm, cues: cached.cues };
      }
    } catch {
      // ignore cache read errors
    }

    try {
      let arrayBuf: ArrayBuffer | null = null;
      if (track.file) {
        arrayBuf = await track.file.arrayBuffer();
      } else if (track.remoteUrl) {
        const res = await fetch(track.remoteUrl, { signal });
        arrayBuf = await res.arrayBuffer();
      }
      if (signal.aborted) return "aborted";
      if (!arrayBuf) return null;

      const offlineCtx = new OfflineAudioContext(1, 1, 22050);
      const audioBuf = await offlineCtx.decodeAudioData(arrayBuf);
      if (signal.aborted) return "aborted";

      const result = await this.workerClient.analyze(
        audioBuf.getChannelData(0),
        audioBuf.sampleRate,
      );
      const effectiveBpm = result.bpm ?? track.bpm;

      try {
        const existing = await get<CachedMeta>(key);
        await set(key, {
          title: existing?.title ?? track.title,
          artist: existing?.artist ?? track.artist,
          duration: existing?.duration ?? audioBuf.duration ?? track.duration,
          bpm: effectiveBpm ?? existing?.bpm ?? null,
          cues: result.cues,
          coverUrl: existing?.coverUrl ?? track.coverUrl,
        } satisfies CachedMeta);
      } catch {
        // ignore quota errors
      }

      return { bpm: effectiveBpm, cues: result.cues };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return "aborted";
      }
      return null;
    }
  }
}

export const analysisScheduler = new AnalysisScheduler();
