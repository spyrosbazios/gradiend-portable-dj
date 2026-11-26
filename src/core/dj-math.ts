export type DeckId = "A" | "B";

const AUDIO_EXT_RE = /\.(mp3|m4a|wav|flac|ogg|aac|opus|webm)$/i;

export function isAudioFile(filename: string): boolean {
  return AUDIO_EXT_RE.test(filename);
}

export function equalPowerGains(crossfade: number): { gainA: number; gainB: number } {
  const x = Math.min(1, Math.max(0, crossfade));
  return {
    gainA: Math.cos(x * Math.PI * 0.5),
    gainB: Math.sin(x * Math.PI * 0.5),
  };
}

export function computeWaveformAndAutoGain(
  channelData: Float32Array,
  barCount = 160,
): { peaks: number[]; autoGain: number } {
  const total = channelData.length;
  if (total === 0 || barCount <= 0) {
    return { peaks: [], autoGain: 1 };
  }

  const blockSize = Math.max(1, Math.floor(total / barCount));
  const peaks: number[] = [];
  let maxPeak = 0;
  let sumSquares = 0;
  let sampledCount = 0;

  for (let i = 0; i < barCount; i++) {
    const start = i * blockSize;
    const end = Math.min(total, start + blockSize);
    const step = Math.max(1, Math.floor((end - start) / 64));
    let localMax = 0;

    for (let j = start; j < end; j += step) {
      const v = Math.abs(channelData[j] ?? 0);
      if (v > localMax) localMax = v;
      sumSquares += v * v;
      sampledCount++;
    }

    peaks.push(localMax);
    if (localMax > maxPeak) maxPeak = localMax;
  }

  const norm = maxPeak > 0.001 ? 1 / maxPeak : 1;
  const normalizedPeaks = peaks.map((p) => Math.max(0.06, Math.min(1, p * norm)));

  const rms = sampledCount > 0 ? Math.sqrt(sumSquares / sampledCount) : 0.2;
  const targetRms = 0.2;
  const rawGain = rms > 0.01 ? targetRms / rms : 1;
  const autoGain = Math.min(1.8, Math.max(0.5, rawGain));

  return { peaks: normalizedPeaks, autoGain };
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const totalSec = Math.floor(seconds);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function parseFilenameMetadata(filename: string): { title: string; artist: string } {
  const withoutExt = filename.replace(AUDIO_EXT_RE, "").trim();
  const cleaned = withoutExt.replace(/^\d{1,3}[\s._-]+/, "").trim();
  const dashIdx = cleaned.indexOf(" - ");
  if (dashIdx > 0) {
    const artist = cleaned.slice(0, dashIdx).trim();
    const title = cleaned.slice(dashIdx + 3).trim();
    if (artist && title) return { title, artist };
  }
  return { title: cleaned || withoutExt || "Untitled Track", artist: "Unknown Artist" };
}

export function getLiveDeck(crossfade: number, playingA: boolean, playingB: boolean): DeckId | null {
  if (playingA && !playingB) return crossfade < 0.95 ? "A" : null;
  if (playingB && !playingA) return crossfade > 0.05 ? "B" : null;
  if (playingA && playingB) return crossfade <= 0.5 ? "A" : "B";
  return null;
}

export function getIdleDeck(crossfade: number, playingA: boolean, playingB: boolean): DeckId {
  const live = getLiveDeck(crossfade, playingA, playingB);
  if (live === "A") return "B";
  if (live === "B") return "A";
  return crossfade <= 0.5 ? "B" : "A";
}

export function isDeckFadedOut(deckId: DeckId, crossfade: number): boolean {
  return deckId === "A" ? crossfade >= 0.95 : crossfade <= 0.05;
}

export interface AudibleBounds {
  cueInSec: number;
  cueOutSec: number;
}

/**
 * Finds the first and last audible energy in a track so fades skip dead intros
 * and start mixing before quiet outro tails.
 */
export function detectAudibleBounds(
  channelData: Float32Array,
  sampleRate: number,
  minIntroSkipSec = 2.5,
): AudibleBounds {
  const duration = sampleRate > 0 ? channelData.length / sampleRate : 0;
  if (duration <= 0) return { cueInSec: 0, cueOutSec: 0 };

  const blockSamples = Math.max(1, Math.floor(sampleRate * 0.1)); // 100ms windows
  const numBlocks = Math.floor(channelData.length / blockSamples);
  const threshold = 0.035;

  let firstAudibleBlock = 0;
  for (let b = 0; b < numBlocks; b++) {
    const start = b * blockSamples;
    const end = Math.min(channelData.length, start + blockSamples);
    const step = Math.max(1, Math.floor((end - start) / 64));
    let peak = 0;
    for (let i = start; i < end; i += step) {
      const v = Math.abs(channelData[i] ?? 0);
      if (v > peak) peak = v;
    }
    if (peak >= threshold) {
      firstAudibleBlock = b;
      break;
    }
  }

  let lastAudibleBlock = Math.max(0, numBlocks - 1);
  for (let b = numBlocks - 1; b >= firstAudibleBlock; b--) {
    const start = b * blockSamples;
    const end = Math.min(channelData.length, start + blockSamples);
    const step = Math.max(1, Math.floor((end - start) / 64));
    let peak = 0;
    for (let i = start; i < end; i += step) {
      const v = Math.abs(channelData[i] ?? 0);
      if (v > peak) peak = v;
    }
    if (peak >= threshold) {
      lastAudibleBlock = b;
      break;
    }
  }

  const detectedIn = firstAudibleBlock * 0.1;
  const detectedOut = Math.min(duration, (lastAudibleBlock + 1) * 0.1);

  // For full tracks (>30s), skip at least minIntroSkipSec (or further if silent intro is longer)
  const cueInSec =
    duration > 30
      ? Math.min(duration * 0.2, Math.max(minIntroSkipSec, detectedIn))
      : Math.min(duration * 0.15, detectedIn);

  // Keep cueOutSec sensible even on very quiet tracks
  const cueOutSec = Math.max(cueInSec + 5, Math.min(duration, detectedOut));

  return { cueInSec, cueOutSec };
}

export type BpmFitStatus = "good" | "ok" | "clash" | "unknown";

export interface BpmFit {
  status: BpmFitStatus;
  diffBpm: number;
  label: string;
}

/**
 * Estimates tempo (BPM) from a mono PCM Float32Array using a downsampled
 * energy-onset envelope + autocorrelation over the 70–175 BPM range.
 */
export function estimateBpm(channelData: Float32Array, sampleRate: number): number | null {
  if (channelData.length < sampleRate * 4 || sampleRate <= 0) return null;

  // Analyze up to 28 seconds from the middle of the track (skipping quiet intros/outros)
  const maxSamples = Math.min(channelData.length, Math.floor(sampleRate * 28));
  const startOffset = Math.max(0, Math.floor((channelData.length - maxSamples) / 2));

  // Build ~100 Hz energy envelope
  const envRate = 100;
  const hop = Math.max(1, Math.floor(sampleRate / envRate));
  const envLen = Math.floor(maxSamples / hop);
  if (envLen < 300) return null;

  const env = new Float32Array(envLen);
  for (let i = 0; i < envLen; i++) {
    const base = startOffset + i * hop;
    const step = Math.max(1, Math.floor(hop / 32));
    let sum = 0;
    let count = 0;
    for (let j = 0; j < hop; j += step) {
      const s = channelData[base + j] ?? 0;
      sum += s * s;
      count++;
    }
    env[i] = count > 0 ? Math.sqrt(sum / count) : 0;
  }

  // Half-wave rectified first-order difference (onset strength)
  const onset = new Float32Array(envLen);
  let meanOnset = 0;
  for (let i = 1; i < envLen; i++) {
    const diff = (env[i] ?? 0) - (env[i - 1] ?? 0);
    const val = diff > 0 ? diff : 0;
    onset[i] = val;
    meanOnset += val;
  }
  meanOnset /= envLen;
  if (meanOnset < 1e-4) return null;

  for (let i = 0; i < envLen; i++) {
    onset[i] = Math.max(0, (onset[i] ?? 0) - meanOnset * 0.5);
  }

  // Autocorrelation across lags corresponding to 70–175 BPM
  const minBpm = 70;
  const maxBpm = 175;
  const minLag = Math.floor((60 * envRate) / maxBpm);
  const maxLag = Math.ceil((60 * envRate) / minBpm);

  let bestLag = 0;
  let bestScore = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    const limit = envLen - lag;
    for (let i = 0; i < limit; i++) {
      score += (onset[i] ?? 0) * (onset[i + lag] ?? 0);
    }
    // Slight preference for typical 95–145 BPM DJ range to avoid sub-harmonic ambiguity
    const bpm = (60 * envRate) / lag;
    const prior = bpm >= 90 && bpm <= 150 ? 1.06 : 1.0;
    const weighted = (score / limit) * prior;
    if (weighted > bestScore) {
      bestScore = weighted;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || bestScore <= 0) return null;
  const rawBpm = (60 * envRate) / bestLag;
  return Math.round(rawBpm);
}

/**
 * Evaluates how smoothly `nextBpm` follows `prevBpm`, accounting for half/double time.
 */
export function evaluateBpmFit(prevBpm: number | null, nextBpm: number | null): BpmFit {
  if (!prevBpm || !nextBpm || prevBpm <= 0 || nextBpm <= 0) {
    return { status: "unknown", diffBpm: 0, label: "Analyzing…" };
  }

  // Compare direct, half-time, and double-time ratios
  const candidates = [nextBpm, nextBpm * 2, nextBpm * 0.5];
  let bestPct = Number.POSITIVE_INFINITY;
  let signedDiff = Math.round(nextBpm - prevBpm);

  for (const cand of candidates) {
    const pct = Math.abs(cand - prevBpm) / prevBpm;
    if (pct < bestPct) {
      bestPct = pct;
      signedDiff = Math.round(cand - prevBpm);
    }
  }

  const sign = signedDiff > 0 ? "+" : "";
  if (bestPct <= 0.06) {
    return {
      status: "good",
      diffBpm: signedDiff,
      label: signedDiff === 0 ? "Exact match" : `Smooth (${sign}${signedDiff})`,
    };
  }
  if (bestPct <= 0.14) {
    return {
      status: "ok",
      diffBpm: signedDiff,
      label: `Shift (${sign}${signedDiff})`,
    };
  }
  return {
    status: "clash",
    diffBpm: signedDiff,
    label: `Big jump (${sign}${signedDiff})`,
  };
}

export interface BpmTrackCandidate {
  id: string;
  bpm: number | null;
}

/**
 * Picks a random unplayed song from the library preferring cached BPMs that
 * match `referenceBpm` closely ("good" ±6% first, then "ok" ±14%, then fallback).
 */
export function pickAutoNextTrack<T extends BpmTrackCandidate>(
  tracks: T[],
  options: {
    referenceBpm: number | null;
    playedIds: Set<string>;
    excludeIds: Set<string>;
    random?: () => number;
  },
): T | null {
  const { referenceBpm, playedIds, excludeIds, random = Math.random } = options;
  const pickRandom = (arr: T[]): T | null => {
    if (arr.length === 0) return null;
    const idx = Math.floor(random() * arr.length);
    return arr[Math.min(arr.length - 1, Math.max(0, idx))] ?? null;
  };

  const eligible = tracks.filter((t) => !excludeIds.has(t.id));
  if (eligible.length === 0) return null;

  const unplayed = eligible.filter((t) => !playedIds.has(t.id));
  const pool = unplayed.length > 0 ? unplayed : eligible;

  if (referenceBpm !== null && referenceBpm > 0) {
    const withBpm = pool.filter((t) => t.bpm !== null);
    const good = withBpm.filter((t) => evaluateBpmFit(referenceBpm, t.bpm).status === "good");
    if (good.length > 0) return pickRandom(good);

    const ok = withBpm.filter((t) => evaluateBpmFit(referenceBpm, t.bpm).status === "ok");
    if (ok.length > 0) return pickRandom(ok);

    if (withBpm.length > 0) return pickRandom(withBpm);
  }

  return pickRandom(pool);
}
