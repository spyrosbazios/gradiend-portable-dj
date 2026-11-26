import { get, set } from "idb-keyval";
import { estimateBpm } from "@/core/dj-math";
import type { TrackItem } from "@/lib/audio-engine";
import { cacheKeyForTrack, type CachedMeta } from "@/lib/library-loader";

export type BpmPriority = "high" | "queued" | "medium" | "low";

interface QueueJob {
  track: TrackItem;
  priority: BpmPriority;
  order: number;
}

type BpmResultCallback = (trackId: string, bpm: number) => void;

const PRIORITY_RANK: Record<BpmPriority, number> = {
  high: 0,
  queued: 1,
  medium: 2,
  low: 3,
};

class BpmWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, (bpm: number | null) => void>();

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
        this.worker = new Worker(new URL("./bpm.worker.ts", import.meta.url), {
          type: "module",
        });
        this.worker.addEventListener("message", (e: MessageEvent<{ id: number; bpm: number | null }>) => {
          const resolve = this.pending.get(e.data.id);
          if (resolve) {
            this.pending.delete(e.data.id);
            resolve(e.data.bpm);
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

  compute(channelData: Float32Array, sampleRate: number): Promise<number | null> {
    if (sampleRate <= 0 || channelData.length < sampleRate * 4) {
      return Promise.resolve(null);
    }

    // Slice ONLY the 28s middle window used by estimateBpm (~2.4 MB vs ~25 MB full song)
    const maxSamples = Math.min(channelData.length, Math.floor(sampleRate * 28));
    const startOffset = Math.max(0, Math.floor((channelData.length - maxSamples) / 2));
    const slice = channelData.slice(startOffset, startOffset + maxSamples);

    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve(estimateBpm(slice, sampleRate));
    }

    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      try {
        worker.postMessage({ id, samples: slice, sampleRate }, [slice.buffer]);
      } catch {
        this.pending.delete(id);
        resolve(estimateBpm(slice, sampleRate));
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

export class BpmScheduler {
  private queue: QueueJob[] = [];
  private queuedMap = new Map<string, QueueJob>();
  private completedIds = new Set<string>();
  private running = false;
  private generation = 0;
  private pauseUntilTs = 0;
  private pausedForFade = false;
  private activeAbort: { priority: BpmPriority; controller: AbortController } | null = null;
  private workerClient = new BpmWorkerClient();
  private onResult: BpmResultCallback | null = null;

  setListener(cb: BpmResultCallback | null): void {
    this.onResult = cb;
  }

  /**
   * Computes BPM off the main thread in the shared Web Worker.
   */
  computeInWorker(channelData: Float32Array, sampleRate: number): Promise<number | null> {
    return this.workerClient.compute(channelData, sampleRate);
  }

  /**
   * Records a BPM already computed during deck loading so background scanning
   * never decodes the same file twice and caches it to IndexedDB immediately.
   */
  recordResult(track: TrackItem, bpm: number, duration?: number): void {
    this.completedIds.add(track.id);
    if (this.queuedMap.has(track.id)) {
      this.queuedMap.delete(track.id);
      this.queue = this.queue.filter((j) => j.track.id !== track.id);
    }
    this.onResult?.(track.id, bpm);
    const key = cacheKeyForTrack(track);
    void (async () => {
      try {
        const existing = await get<CachedMeta>(key);
        await set(key, {
          title: existing?.title ?? track.title,
          artist: existing?.artist ?? track.artist,
          duration: existing?.duration ?? duration ?? track.duration,
          bpm,
          coverUrl: existing?.coverUrl ?? track.coverUrl,
        });
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
    // Demote any previous focus-window jobs back to low priority
    for (const job of this.queue) {
      if (job.priority === "high" || job.priority === "medium") {
        job.priority = "low";
        job.order = 1000;
      }
    }

    let promoted = false;
    if (selected.bpm === null && !this.completedIds.has(selected.id)) {
      this.upsertJob(selected, "high", 0);
      promoted = true;
    }

    for (let i = 0; i < neighbors.length; i++) {
      const neighbor = neighbors[i];
      if (!neighbor || neighbor.bpm !== null || this.completedIds.has(neighbor.id)) continue;
      this.upsertJob(neighbor, "medium", i + 1);
      promoted = true;
    }

    if (promoted) {
      this.sortQueue();
      // If we are currently fetching a low-priority background track, abort it so focus wins immediately
      if (this.activeAbort?.priority === "low") {
        this.activeAbort.controller.abort();
      }
      if (!this.running) {
        void this.runLoop(this.generation);
      }
    }
  }

  enqueue(track: TrackItem, priority: BpmPriority): void {
    if (track.bpm !== null || this.completedIds.has(track.id)) return;
    this.upsertJob(track, priority, priority === "high" ? 0 : 10);
    this.sortQueue();
    if (!this.running) {
      void this.runLoop(this.generation);
    }
  }

  enqueueMany(tracks: TrackItem[], priority: BpmPriority): void {
    let added = false;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (!track || track.bpm !== null || this.completedIds.has(track.id)) continue;
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

  private upsertJob(track: TrackItem, priority: BpmPriority, order: number): void {
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
          // Put the interrupted low-priority job back so it finishes later
          this.upsertJob(job.track, "low", 1000);
          this.sortQueue();
          continue;
        }

        this.completedIds.add(job.track.id);
        if (typeof result === "number") {
          this.onResult?.(job.track.id, result);
        }

        // Fast turnaround for focus window; gentle breather for background trickle (400-song friendly)
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
  ): Promise<number | null | "aborted"> {
    const key = cacheKeyForTrack(track);
    try {
      const cached = await get<CachedMeta>(key);
      if (cached?.bpm) return cached.bpm;
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

      const bpm = await this.workerClient.compute(
        audioBuf.getChannelData(0),
        audioBuf.sampleRate,
      );

      if (bpm !== null) {
        try {
          const existing = await get<CachedMeta>(key);
          await set(key, {
            title: existing?.title ?? track.title,
            artist: existing?.artist ?? track.artist,
            duration: existing?.duration ?? audioBuf.duration ?? track.duration,
            bpm,
            coverUrl: existing?.coverUrl ?? track.coverUrl,
          });
        } catch {
          // ignore quota errors
        }
      }
      return bpm;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return "aborted";
      }
      return null;
    }
  }
}

export const bpmScheduler = new BpmScheduler();
