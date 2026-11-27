import { detectKey, keyFit, type KeyFit, type MusicalKey } from "@/core/key-detect";

export type DeckId = "A" | "B";

const AUDIO_EXT_RE = /\.(mp3|m4a|wav|flac|ogg|aac|opus|webm)$/i;

export function isAudioFile(filename: string): boolean {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  // Ignore macOS AppleDouble resource forks (._Song.mp3) and hidden dotfiles on USB sticks
  if (!base || base.startsWith(".")) return false;
  return AUDIO_EXT_RE.test(base);
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

export type BpmFitStatus = "good" | "ok" | "clash" | "unknown";

export interface BpmFit {
  status: BpmFitStatus;
  diffBpm: number;
  label: string;
}

export interface BeatGrid {
  bpm: number;
  /** Timestamp (seconds) of bar 0, beat 1; bar n = firstDownbeatSec + n * 4 * 60 / bpm. */
  firstDownbeatSec: number;
}

export type SpotQuality = "good" | "ok" | "risky";

export interface CueSpot {
  bar: number;
  sec: number;
  quality: SpotQuality;
  reason: string;
}

export const TRACK_CUES_VERSION = 3 as const;

export interface TrackCues {
  version: typeof TRACK_CUES_VERSION;
  grid: BeatGrid | null;
  entries: CueSpot[];
  exits: CueSpot[];
  bestEntryBar: number;
  bestExitBar: number;
  confidence: "high" | "low";
  /** Detected musical key, for harmonic (Camelot) compatibility. */
  key: MusicalKey | null;
}

export interface AudioEnvelopes {
  envRate: number;
  durationSec: number;
  total: Float32Array;
  low: Float32Array;
  mid: Float32Array;
}

export interface BeatGridResult {
  bpm: number | null;
  grid: BeatGrid | null;
  confidence: "high" | "low";
  fitStrength: number;
}

/**
 * Computes ~100 Hz RMS envelopes for total energy, low band (< 150 Hz one-pole LPF),
 * and mid band (300 Hz–3 kHz vocal proxy) over the entire mono PCM buffer.
 */
export function computeBandEnvelopes(
  channelData: Float32Array,
  sampleRate: number,
): AudioEnvelopes {
  if (sampleRate <= 0 || channelData.length === 0) {
    return {
      envRate: 100,
      durationSec: 0,
      total: new Float32Array(0),
      low: new Float32Array(0),
      mid: new Float32Array(0),
    };
  }

  const hop = Math.max(1, Math.round(sampleRate / 100));
  const envRate = sampleRate / hop;
  const envLen = Math.floor(channelData.length / hop);
  const durationSec = channelData.length / sampleRate;

  const total = new Float32Array(envLen);
  const low = new Float32Array(envLen);
  const mid = new Float32Array(envLen);

  const totalAcc = new Float32Array(envLen);
  const lowAcc = new Float32Array(envLen);
  const midAcc = new Float32Array(envLen);

  // Precompute half-Hann weights so each sample contributes to adjacent frames,
  // forming a 20 ms Hann-weighted RMS centered at frame / envRate with minimal tone ripple.
  const wCurr = new Float32Array(hop);
  for (let j = 0; j < hop; j++) {
    wCurr[j] = 0.5 * (1 + Math.cos((Math.PI * j) / hop));
  }

  // One-pole low-pass (< 150 Hz) for kick/bass energy
  const lowCutoff = Math.min(150, sampleRate * 0.45);
  const alphaLow = 1 - Math.exp((-2 * Math.PI * lowCutoff) / sampleRate);

  // Cascaded one-pole HPF (300 Hz) + one-pole LPF (3 kHz) for vocal proxy
  const midHpCutoff = Math.min(300, sampleRate * 0.4);
  const midLpCutoff = Math.min(3000, sampleRate * 0.45);
  const aMidHp = 1 / (1 + (2 * Math.PI * midHpCutoff) / sampleRate);
  const alphaMidLp = 1 - Math.exp((-2 * Math.PI * midLpCutoff) / sampleRate);

  let lowY = 0;
  let hp1 = 0;
  let prevX = 0;
  let hp2 = 0;
  let prevHp1 = 0;
  let midY = 0;

  for (let frame = 0; frame < envLen; frame++) {
    const base = frame * hop;
    const hasNext = frame + 1 < envLen;
    let sumCurrTotal = 0;
    let sumCurrLow = 0;
    let sumCurrMid = 0;
    let sumNextTotal = 0;
    let sumNextLow = 0;
    let sumNextMid = 0;

    for (let j = 0; j < hop; j++) {
      const x = channelData[base + j] ?? 0;

      lowY += alphaLow * (x - lowY);

      const nextHp1 = aMidHp * (hp1 + x - prevX);
      prevX = x;
      hp1 = nextHp1;

      const nextHp2 = aMidHp * (hp2 + hp1 - prevHp1);
      prevHp1 = hp1;
      hp2 = nextHp2;

      midY += alphaMidLp * (hp2 - midY);

      const x2 = x * x;
      const l2 = lowY * lowY;
      const m2 = midY * midY;
      const w = wCurr[j] ?? 0.5;
      const wNext = 1 - w;

      sumCurrTotal += x2 * w;
      sumCurrLow += l2 * w;
      sumCurrMid += m2 * w;
      if (hasNext) {
        sumNextTotal += x2 * wNext;
        sumNextLow += l2 * wNext;
        sumNextMid += m2 * wNext;
      }
    }

    totalAcc[frame] = (totalAcc[frame] ?? 0) + sumCurrTotal;
    lowAcc[frame] = (lowAcc[frame] ?? 0) + sumCurrLow;
    midAcc[frame] = (midAcc[frame] ?? 0) + sumCurrMid;
    if (hasNext) {
      totalAcc[frame + 1] = (totalAcc[frame + 1] ?? 0) + sumNextTotal;
      lowAcc[frame + 1] = (lowAcc[frame + 1] ?? 0) + sumNextLow;
      midAcc[frame + 1] = (midAcc[frame + 1] ?? 0) + sumNextMid;
    }
  }

  for (let frame = 0; frame < envLen; frame++) {
    // Frame 0 only receives the right half-window (total weight = 0.5 * hop)
    const norm = frame === 0 ? 0.5 * hop : hop;
    total[frame] = Math.sqrt((totalAcc[frame] ?? 0) / norm);
    low[frame] = Math.sqrt((lowAcc[frame] ?? 0) / norm);
    mid[frame] = Math.sqrt((midAcc[frame] ?? 0) / norm);
  }

  return { envRate, durationSec, total, low, mid };
}

export function findAudibleRange(
  totalEnv: Float32Array,
  envRate: number,
  durationSec: number,
): { startSec: number; endSec: number } {
  if (totalEnv.length === 0 || envRate <= 0 || durationSec <= 0) {
    return { startSec: 0, endSec: Math.max(0, durationSec) };
  }

  let maxRms = 0;
  for (let i = 0; i < totalEnv.length; i++) {
    const v = totalEnv[i] ?? 0;
    if (v > maxRms) maxRms = v;
  }
  if (maxRms < 1e-4) {
    return { startSec: 0, endSec: durationSec };
  }

  const threshold = Math.max(0.012, Math.min(0.035, maxRms * 0.08));
  let firstFrame = 0;
  for (let i = 0; i < totalEnv.length; i++) {
    if ((totalEnv[i] ?? 0) >= threshold) {
      firstFrame = i;
      break;
    }
  }

  let lastFrame = totalEnv.length - 1;
  for (let i = totalEnv.length - 1; i >= firstFrame; i--) {
    if ((totalEnv[i] ?? 0) >= threshold) {
      lastFrame = i;
      break;
    }
  }

  return {
    startSec: firstFrame / envRate,
    endSec: Math.min(durationSec, (lastFrame + 1) / envRate),
  };
}

function buildOnsetEnvelope(env: Float32Array): { onset: Float32Array; mean: number } {
  const n = env.length;
  const onset = new Float32Array(n);
  if (n < 2) return { onset, mean: 0 };

  let sum = 0;
  let rmsSum = env[0] ?? 0;
  for (let i = 1; i < n; i++) {
    const curr = env[i] ?? 0;
    rmsSum += curr;
    const diff = curr - (env[i - 1] ?? 0);
    const val = diff > 0 ? diff : 0;
    onset[i] = val;
    sum += val;
  }

  const mean = sum / n;
  const meanRms = rmsSum / n;
  // Reject flat/sustained drones where frame-to-frame ripple is negligible relative to loudness
  if (mean < 1e-4 || mean < meanRms * 0.015) {
    onset.fill(0);
    return { onset, mean: 0 };
  }

  const floor = mean * 0.5;
  for (let i = 0; i < n; i++) {
    const v = (onset[i] ?? 0) - floor;
    onset[i] = v > 0 ? v : 0;
  }
  return { onset, mean };
}

function sampleLinear(arr: Float32Array, pos: number): number {
  const n = arr.length;
  if (pos < 0 || pos >= n - 1) {
    const idx = Math.round(pos);
    return idx >= 0 && idx < n ? (arr[idx] ?? 0) : 0;
  }
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return (arr[lo] ?? 0) * (1 - frac) + (arr[lo + 1] ?? 0) * frac;
}

function fractionalAutocorr(onset: Float32Array, lag: number): number {
  const n = onset.length;
  const lo = Math.floor(lag);
  const frac = lag - lo;
  const limit = n - lo - 1;
  if (limit <= 0) return 0;

  let sum = 0;
  const invFrac = 1 - frac;
  for (let i = 0; i < limit; i++) {
    const a = onset[i] ?? 0;
    if (a === 0) continue;
    const b = (onset[i + lo] ?? 0) * invFrac + (onset[i + lo + 1] ?? 0) * frac;
    sum += a * b;
  }
  return sum / limit;
}

function estimateBpmFromOnset(
  onset: Float32Array,
  envRate: number,
): { bpm: number; peakRatio: number } | null {
  const envLen = onset.length;
  if (envLen < Math.floor(envRate * 3)) return null;

  const minBpm = 70;
  const maxBpm = 175;
  const minLag = Math.max(1, Math.floor((60 * envRate) / maxBpm));
  const maxLag = Math.min(envLen - 2, Math.ceil((60 * envRate) / minBpm));
  if (maxLag <= minLag) return null;

  const rawScores = new Float32Array(maxLag + 2);
  let bestLag = 0;
  let bestWeighted = -1;
  let sumRaw = 0;
  let lagCount = 0;

  // Include one-frame margin on both sides for parabolic interpolation
  const scanStart = Math.max(1, minLag - 1);
  const scanEnd = Math.min(envLen - 2, maxLag + 1);
  for (let lag = scanStart; lag <= scanEnd; lag++) {
    let score = 0;
    const limit = envLen - lag;
    for (let i = 0; i < limit; i++) {
      score += (onset[i] ?? 0) * (onset[i + lag] ?? 0);
    }
    const raw = score / limit;
    rawScores[lag] = raw;

    if (lag >= minLag && lag <= maxLag) {
      sumRaw += raw;
      lagCount++;
      const bpm = (60 * envRate) / lag;
      const prior = bpm >= 90 && bpm <= 150 ? 1.06 : 1.0;
      const weighted = raw * prior;
      if (weighted > bestWeighted) {
        bestWeighted = weighted;
        bestLag = lag;
      }
    }
  }

  if (bestLag <= 0 || bestWeighted <= 0 || lagCount === 0) return null;

  const bestRaw = rawScores[bestLag] ?? 0;
  const meanRaw = sumRaw / lagCount;
  const peakRatio = meanRaw > 1e-12 ? bestRaw / meanRaw : 0;

  // Parabolic interpolation around bestLag for initial fractional BPM
  const prev = rawScores[bestLag - 1] ?? bestRaw;
  const next = rawScores[bestLag + 1] ?? bestRaw;
  const denom = prev - 2 * bestRaw + next;
  let refinedLag = bestLag;
  if (Math.abs(denom) > 1e-12) {
    const delta = Math.max(-0.5, Math.min(0.5, (0.5 * (prev - next)) / denom));
    refinedLag = bestLag + delta;
  }

  const coarseBpm = (60 * envRate) / refinedLag;

  // Two-stage fine BPM refinement using 1-, 2-, 4-, and 8-beat harmonic lags
  const scoreBpmCandidate = (candBpm: number): number => {
    const beatLag = (60 * envRate) / candBpm;
    let totalScore = fractionalAutocorr(onset, beatLag);
    if (beatLag * 2 < envLen - 2) {
      totalScore += fractionalAutocorr(onset, beatLag * 2);
    }
    if (beatLag * 4 < envLen - 2) {
      totalScore += 1.5 * fractionalAutocorr(onset, beatLag * 4);
    }
    if (beatLag * 8 < envLen - 2) {
      totalScore += 1.5 * fractionalAutocorr(onset, beatLag * 8);
    }
    return totalScore;
  };

  let bestFineBpm = coarseBpm;
  let bestFineScore = -1;
  const coarseLo = Math.max(minBpm, coarseBpm - 2.5);
  const coarseHi = Math.min(maxBpm, coarseBpm + 2.5);
  for (let b = coarseLo; b <= coarseHi + 1e-6; b += 0.25) {
    const s = scoreBpmCandidate(b);
    if (s > bestFineScore) {
      bestFineScore = s;
      bestFineBpm = b;
    }
  }

  let finalBpm = bestFineBpm;
  let finalScore = bestFineScore;
  const fineLo = Math.max(minBpm, bestFineBpm - 0.35);
  const fineHi = Math.min(maxBpm, bestFineBpm + 0.35);
  for (let b = fineLo; b <= fineHi + 1e-6; b += 0.05) {
    const s = scoreBpmCandidate(b);
    if (s > finalScore) {
      finalScore = s;
      finalBpm = b;
    }
  }

  return {
    bpm: Math.round(finalBpm * 10) / 10,
    peakRatio,
  };
}

/**
 * Detects tempo (BPM), downbeat phase (bar 0, beat 1), and fit confidence from
 * precomputed multi-band ~100 Hz envelopes.
 */
export function detectBeatGridFromEnvelopes(envelopes: AudioEnvelopes): BeatGridResult {
  const { envRate, durationSec, total, low } = envelopes;
  if (total.length < Math.floor(envRate * 4) || durationSec < 4) {
    return { bpm: null, grid: null, confidence: "low", fitStrength: 0 };
  }

  const totalOnsetRes = buildOnsetEnvelope(total);
  if (totalOnsetRes.mean <= 0) {
    return { bpm: null, grid: null, confidence: "low", fitStrength: 0 };
  }

  const bpmRes = estimateBpmFromOnset(totalOnsetRes.onset, envRate);
  if (!bpmRes) {
    return { bpm: null, grid: null, confidence: "low", fitStrength: 0 };
  }

  const { bpm, peakRatio } = bpmRes;
  if (peakRatio < 1.35) {
    return { bpm: null, grid: null, confidence: "low", fitStrength: peakRatio };
  }

  const lowOnsetRes = buildOnsetEnvelope(low);

  // Measure whether low band carries meaningful energy (distinguishes kicks from high-only clicks)
  let sumTotalRms = 0;
  let sumLowRms = 0;
  for (let i = 0; i < total.length; i++) {
    sumTotalRms += total[i] ?? 0;
    sumLowRms += low[i] ?? 0;
  }
  const hasLowEnergy = sumTotalRms > 0 && sumLowRms > sumTotalRms * 0.06 && lowOnsetRes.mean > 0;

  const envLen = total.length;
  const normTotal = new Float32Array(envLen);
  const normLow = new Float32Array(envLen);
  const beatSignal = new Float32Array(envLen);
  const downbeatSignal = new Float32Array(envLen);

  const totalScale = totalOnsetRes.mean > 0 ? 1 / totalOnsetRes.mean : 0;
  const lowScale = hasLowEnergy && lowOnsetRes.mean > 0 ? 1 / lowOnsetRes.mean : 0;

  for (let i = 0; i < envLen; i++) {
    const nt = (totalOnsetRes.onset[i] ?? 0) * totalScale;
    const nl = (lowOnsetRes.onset[i] ?? 0) * lowScale;
    normTotal[i] = nt;
    normLow[i] = nl;
    beatSignal[i] = hasLowEnergy ? 0.65 * nl + 0.35 * nt : nt;
    downbeatSignal[i] = hasLowEnergy ? 0.85 * nl + 0.15 * nt : nt;
  }

  const audible = findAudibleRange(total, envRate, durationSec);
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;

  // Fine phase search within one beat (~5 ms resolution)
  const numShifts = Math.max(24, Math.round(beatSec * envRate * 2));
  const shiftScores = new Float32Array(numShifts);
  let bestShiftIdx = 0;
  let bestShiftScore = -1;
  let sumShiftScores = 0;

  for (let s = 0; s < numShifts; s++) {
    const phiSec = (s / numShifts) * beatSec;
    const firstK = Math.max(0, Math.ceil((audible.startSec - phiSec) / beatSec));
    let sum = 0;
    let count = 0;
    for (let k = firstK; ; k++) {
      const t = phiSec + k * beatSec;
      if (t >= audible.endSec) break;
      sum += sampleLinear(beatSignal, t * envRate);
      count++;
    }
    const avg = count > 0 ? sum / count : 0;
    shiftScores[s] = avg;
    sumShiftScores += avg;
    if (avg > bestShiftScore) {
      bestShiftScore = avg;
      bestShiftIdx = s;
    }
  }

  const meanShiftScore = sumShiftScores / numShifts;
  const phaseConcentration = meanShiftScore > 1e-12 ? bestShiftScore / meanShiftScore : 0;
  if (phaseConcentration < 1.25) {
    return {
      bpm: Math.round(bpm),
      grid: null,
      confidence: "low",
      fitStrength: Math.min(peakRatio, phaseConcentration),
    };
  }

  // Circular parabolic refinement around bestShiftIdx
  const prevShift = shiftScores[(bestShiftIdx - 1 + numShifts) % numShifts] ?? bestShiftScore;
  const nextShift = shiftScores[(bestShiftIdx + 1) % numShifts] ?? bestShiftScore;
  const shiftDenom = prevShift - 2 * bestShiftScore + nextShift;
  let refinedShift = bestShiftIdx;
  if (Math.abs(shiftDenom) > 1e-12) {
    const delta = Math.max(-0.5, Math.min(0.5, (0.5 * (prevShift - nextShift)) / shiftDenom));
    refinedShift = (bestShiftIdx + delta + numShifts) % numShifts;
  }
  const bestBeatPhaseSec = (refinedShift / numShifts) * beatSec;

  // Test the 4 beat offsets (0..3) to identify beat 1 (downbeat)
  let bestBarOffset = 0;
  let bestBarScore = -1;
  const barOffsetScores = [0, 0, 0, 0];

  const firstGlobalBeat = Math.max(
    0,
    Math.ceil((audible.startSec - bestBeatPhaseSec) / beatSec),
  );
  const totalBeats = Math.floor((audible.endSec - bestBeatPhaseSec) / beatSec) + 1;
  const beatAccent = new Float32Array(Math.max(0, totalBeats));
  const beatEnergy = new Float32Array(Math.max(0, totalBeats));

  for (let k = firstGlobalBeat; k < totalBeats; k++) {
    const t = bestBeatPhaseSec + k * beatSec;
    const f = t * envRate;
    // Take local peak within ±1 frame to tolerate slight one-pole filter attack lag
    const c0 = sampleLinear(downbeatSignal, f);
    const cPrev = sampleLinear(downbeatSignal, f - 0.75);
    const cNext = sampleLinear(downbeatSignal, f + 0.75);
    beatAccent[k] = Math.max(c0, 0.9 * cPrev, 0.9 * cNext);

    const fStart = Math.max(0, Math.floor(f));
    const fEnd = Math.min(envLen, Math.floor((t + beatSec) * envRate));
    let eSum = 0;
    let eCount = 0;
    for (let j = fStart; j < fEnd; j++) {
      eSum += total[j] ?? 0;
      eCount++;
    }
    beatEnergy[k] = eCount > 0 ? eSum / eCount : 0;
  }

  for (let offset = 0; offset < 4; offset++) {
    let accentSum = 0;
    let accentCount = 0;
    let noveltySum = 0;
    let noveltyCount = 0;

    for (let k = firstGlobalBeat; k < totalBeats; k++) {
      if (k % 4 !== offset) continue;
      accentSum += beatAccent[k] ?? 0;
      accentCount++;

      // Bar-boundary energy novelty (helps 4-on-the-floor tracks with identical kicks)
      if (k >= firstGlobalBeat + 4 && k + 3 < totalBeats) {
        const before =
          ((beatEnergy[k - 4] ?? 0) +
            (beatEnergy[k - 3] ?? 0) +
            (beatEnergy[k - 2] ?? 0) +
            (beatEnergy[k - 1] ?? 0)) *
          0.25;
        const after =
          ((beatEnergy[k] ?? 0) +
            (beatEnergy[k + 1] ?? 0) +
            (beatEnergy[k + 2] ?? 0) +
            (beatEnergy[k + 3] ?? 0)) *
          0.25;
        noveltySum += Math.abs(after - before);
        noveltyCount++;
      }
    }

    const avgAccent = accentCount > 0 ? accentSum / accentCount : 0;
    const avgNovelty = noveltyCount > 0 ? noveltySum / noveltyCount : 0;
    const score = avgAccent + 0.15 * avgNovelty;
    barOffsetScores[offset] = score;
    if (score > bestBarScore) {
      bestBarScore = score;
      bestBarOffset = offset;
    }
  }

  let barPhaseSec = bestBeatPhaseSec + bestBarOffset * beatSec;
  if (barSec - barPhaseSec < 0.03) {
    barPhaseSec = 0;
  }

  // Anchor firstDownbeatSec at the first bar downbeat at or just around audible start
  let firstDownbeatSec = barPhaseSec;
  const minDownbeat = Math.max(0, audible.startSec - beatSec * 0.25);
  if (firstDownbeatSec < minDownbeat) {
    const barsToAdvance = Math.ceil((minDownbeat - firstDownbeatSec) / barSec);
    firstDownbeatSec += barsToAdvance * barSec;
  }
  firstDownbeatSec = Math.round(Math.max(0, firstDownbeatSec) * 10000) / 10000;

  const fitStrength = Math.min(peakRatio, phaseConcentration);
  const confidence: "high" | "low" =
    peakRatio >= 1.6 && phaseConcentration >= 1.45 ? "high" : "low";

  return {
    bpm: Math.round(bpm),
    grid: { bpm, firstDownbeatSec },
    confidence,
    fitStrength,
  };
}

/**
 * Detects tempo (BPM) and bar-1 downbeat grid directly from mono PCM samples.
 */
export function detectBeatGrid(channelData: Float32Array, sampleRate: number): BeatGridResult {
  const envelopes = computeBandEnvelopes(channelData, sampleRate);
  return detectBeatGridFromEnvelopes(envelopes);
}

interface BarFeature {
  energy: number;
  low: number;
  mid: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

function averageRange(bars: BarFeature[], start: number, end: number): BarFeature {
  const s = Math.max(0, start);
  const e = Math.min(bars.length, end);
  if (e <= s) return { energy: 0, low: 0, mid: 0 };
  let energy = 0;
  let low = 0;
  let mid = 0;
  for (let i = s; i < e; i++) {
    const b = bars[i];
    if (!b) continue;
    energy += b.energy;
    low += b.low;
    mid += b.mid;
  }
  const count = e - s;
  return { energy: energy / count, low: low / count, mid: mid / count };
}

function buildFallbackCues(
  audibleStartSec: number,
  audibleEndSec: number,
  key: MusicalKey | null,
): TrackCues {
  const safeStart = Math.max(0, Math.round(audibleStartSec * 100) / 100);
  const span = Math.max(0, audibleEndSec - safeStart);
  const tailLead = Math.min(12, Math.max(2, span * 0.2));
  const safeEnd = Math.max(safeStart, Math.round((audibleEndSec - tailLead) * 100) / 100);

  return {
    version: TRACK_CUES_VERSION,
    key,
    grid: null,
    entries: [
      {
        bar: 0,
        sec: safeStart,
        quality: "ok",
        reason: "no beat grid · echo-out",
      },
    ],
    exits: [
      {
        bar: 0,
        sec: safeEnd,
        quality: "ok",
        reason: "no beat grid · fade before end",
      },
    ],
    bestEntryBar: 0,
    bestExitBar: 0,
    confidence: "low",
  };
}

/**
 * Computes per-bar normalized features, 8-bar phrase starts, entry/exit ratings,
 * and fallback cues from precomputed multi-band envelopes.
 */
export function analyzeTrackCuesFromEnvelopes(
  envelopes: AudioEnvelopes,
  key: MusicalKey | null,
): {
  bpm: number | null;
  cues: TrackCues;
} {
  const { envRate, durationSec, total, low, mid } = envelopes;
  const audible = findAudibleRange(total, envRate, durationSec);
  const gridRes = detectBeatGridFromEnvelopes(envelopes);

  if (!gridRes.grid) {
    return {
      bpm: gridRes.bpm,
      cues: buildFallbackCues(audible.startSec, audible.endSec, key),
    };
  }

  const { grid, confidence } = gridRes;
  const barSec = (4 * 60) / grid.bpm;
  const numBars = Math.floor((audible.endSec - grid.firstDownbeatSec + barSec * 0.25) / barSec);

  if (numBars < 8) {
    return {
      bpm: gridRes.bpm,
      cues: buildFallbackCues(audible.startSec, audible.endSec, key),
    };
  }

  const rawEnergy: number[] = [];
  const rawLow: number[] = [];
  const rawMid: number[] = [];

  for (let b = 0; b < numBars; b++) {
    const t0 = grid.firstDownbeatSec + b * barSec;
    const t1 = t0 + barSec;
    const f0 = Math.max(0, Math.floor(t0 * envRate));
    const f1 = Math.min(total.length, Math.max(f0 + 1, Math.floor(t1 * envRate)));

    let sumE = 0;
    let sumL = 0;
    let sumM = 0;
    const count = Math.max(1, f1 - f0);
    for (let f = f0; f < f1; f++) {
      sumE += total[f] ?? 0;
      sumL += low[f] ?? 0;
      sumM += mid[f] ?? 0;
    }
    rawEnergy.push(sumE / count);
    rawLow.push(sumL / count);
    rawMid.push(sumM / count);
  }

  // Normalize per track while floor-guarding low/mid scales against total energy so
  // instrumental kick tracks don't amplify negligible mid-band leakage into false vocals.
  const p95Energy = Math.max(percentile(rawEnergy, 0.95), 1e-4);
  const p95Low = Math.max(percentile(rawLow, 0.95), p95Energy * 0.25, 1e-4);
  const p95Mid = Math.max(percentile(rawMid, 0.95), p95Energy * 0.25, 1e-4);

  const bars: BarFeature[] = [];
  for (let b = 0; b < numBars; b++) {
    bars.push({
      energy: clamp01((rawEnergy[b] ?? 0) / p95Energy),
      low: clamp01((rawLow[b] ?? 0) / p95Low),
      mid: clamp01((rawMid[b] ?? 0) / p95Mid),
    });
  }

  const audibleSpan = Math.max(audible.endSec - audible.startSec, 1);
  const entries: CueSpot[] = [];
  const exits: CueSpot[] = [];

  let bestEntryBar = 0;
  let bestEntryScore = Number.NEGATIVE_INFINITY;
  let bestExitBar = 0;
  let bestExitScore = Number.NEGATIVE_INFINITY;

  for (let bar = 0; bar < numBars; bar += 8) {
    const sec = Math.round((grid.firstDownbeatSec + bar * barSec) * 1000) / 1000;
    if (sec >= audible.endSec - barSec * 0.5) break;

    const before4 = bar === 0 ? { energy: 0, low: 0, mid: 0 } : averageRange(bars, bar - 4, bar);
    const before1 = bar === 0 ? { energy: 0, low: 0, mid: 0 } : (bars[bar - 1] ?? before4);
    const barN = bars[bar] ?? { energy: 0, low: 0, mid: 0 };
    const after4 = averageRange(bars, bar, bar + 4);
    const after8 = averageRange(bars, bar, bar + 8);
    const nextPhrase = averageRange(bars, bar + 8, bar + 16);

    // Boundary novelty between bar n-1 and bar n highlights real section changes
    const novelty =
      bar === 0
        ? barN.energy
        : Math.abs(barN.energy - before1.energy) +
          0.7 * Math.abs(barN.low - before1.low) +
          0.7 * Math.abs(barN.mid - before1.mid);

    const posFrac = clamp01((sec - audible.startSec) / audibleSpan);
    const barsRemaining = (audible.endSec - sec) / barSec;

    // Vocals are judged on the 2 bars either side of the boundary: 4-bar averages blur a
    // vocal that starts or stops right at the phrase, which is exactly the best mix point.
    // Tuned against Demucs-separated vocal stems of real vocal-house tracks.
    const before2 = bar === 0 ? { energy: 0, low: 0, mid: 0 } : averageRange(bars, bar - 2, bar);
    const after2 = averageRange(bars, bar, bar + 2);
    const vocalsSustained = bar > 0 && before2.mid >= 0.4 && after2.mid >= 0.4;
    // A full-energy groove is a normal place to mix with a bass swap, so it lowers the
    // rating to "ok" instead of marking it risky.
    const insideDrop =
      bar > 0 &&
      before4.energy >= 0.72 &&
      after4.energy >= 0.72 &&
      after4.energy - before4.energy > -0.15;

    // --- Entry rating ---
    let entryQuality: SpotQuality;
    let entryReason: string;
    if (vocalsSustained) {
      entryQuality = "risky";
      entryReason = "vocals across boundary";
    } else if (insideDrop) {
      entryQuality = "ok";
      entryReason = "full groove, bass swap";
    } else if (barsRemaining < 8 || posFrac > 0.78) {
      entryQuality = "risky";
      entryReason = "too late in track";
    } else {
      const inFirstThird = bar === 0 || posFrac <= 0.38;
      const cleanBefore = bar === 0 || (before4.mid < 0.35 && before4.energy < 0.68);
      const energyRises =
        after8.energy > before4.energy + 0.04 ||
        nextPhrase.energy > after8.energy + 0.05 ||
        (bar === 0 && after8.energy > 0.02);
      const noImmediateVocals = after4.mid < 0.45;

      if (inFirstThird && cleanBefore && energyRises && noImmediateVocals) {
        entryQuality = "good";
        if (bar === 0) {
          entryReason = "intro, no vocals";
        } else if (after4.energy - before4.energy >= 0.18) {
          entryReason = "energy builds, no vocals";
        } else {
          entryReason = "clean intro, no vocals";
        }
      } else {
        entryQuality = "ok";
        if (after4.mid >= 0.45) {
          entryReason = "vocals enter here";
        } else if (posFrac > 0.38) {
          entryReason = "mid-track, short fade";
        } else {
          entryReason = "usable with short fade";
        }
      }
    }

    entries.push({ bar, sec, quality: entryQuality, reason: entryReason });

    const entryBase = entryQuality === "good" ? 100 : entryQuality === "ok" ? 40 : 0;
    const entryScore =
      entryBase +
      (1 - before4.mid) * 20 +
      (1 - after4.mid) * 18 +
      (1 - before4.energy) * 12 +
      Math.max(0, after8.energy - before4.energy) * 25 +
      Math.min(1, novelty) * 18 +
      (posFrac <= 0.35 ? (1 - posFrac) * 18 : -posFrac * 30) +
      (after4.energy >= 0.2 ? 8 : 0);

    if (entryScore > bestEntryScore) {
      bestEntryScore = entryScore;
      bestEntryBar = bar;
    }

    // --- Exit rating ---
    let exitQuality: SpotQuality;
    let exitReason: string;
    if (vocalsSustained) {
      exitQuality = "risky";
      exitReason = "vocals across boundary";
    } else if (insideDrop) {
      exitQuality = "ok";
      exitReason = "full groove, bass swap";
    } else if (barsRemaining < 7.5) {
      exitQuality = "risky";
      exitReason = "too close to end";
    } else {
      const hasRoom = barsRemaining >= 15.5;
      const energyFalls =
        before4.energy - after8.energy >= 0.12 ||
        (after8.energy < 0.52 && before4.energy - after8.energy >= 0.05);
      const vocalsFall = before4.mid - after4.mid >= 0.18 && after4.mid < 0.4;

      if (bar > 0 && hasRoom && (energyFalls || vocalsFall) && after4.mid < 0.42) {
        exitQuality = "good";
        if (energyFalls && vocalsFall) {
          exitReason = "outro, vocals clear";
        } else if (vocalsFall) {
          exitReason = "vocals end here";
        } else {
          exitReason = "energy drops, clean outro";
        }
      } else {
        exitQuality = "ok";
        if (!hasRoom && after4.mid < 0.42) {
          exitReason = "short outro, quick fade";
        } else if (bar === 0) {
          exitReason = "track start";
        } else {
          exitReason = "usable with short fade";
        }
      }
    }

    exits.push({ bar, sec, quality: exitQuality, reason: exitReason });

    const exitBase = exitQuality === "good" ? 100 : exitQuality === "ok" ? 40 : 0;
    const positionBonus =
      posFrac >= 0.5 && posFrac <= 0.92
        ? 25 + posFrac * 15
        : posFrac < 0.25
          ? -45
          : 0;
    const exitScore =
      exitBase +
      Math.max(0, before4.energy - after8.energy) * 30 +
      Math.max(0, before4.mid - after4.mid) * 28 +
      Math.min(1, novelty) * 18 +
      (1 - after4.mid) * 15 +
      positionBonus +
      (barsRemaining >= 15.5 ? 12 : -15);

    if (exitScore > bestExitScore) {
      bestExitScore = exitScore;
      bestExitBar = bar;
    }
  }

  if (entries.length === 0 || exits.length === 0) {
    return {
      bpm: gridRes.bpm,
      cues: buildFallbackCues(audible.startSec, audible.endSec, key),
    };
  }

  return {
    bpm: gridRes.bpm,
    cues: {
      version: TRACK_CUES_VERSION,
      grid,
      entries,
      exits,
      bestEntryBar,
      bestExitBar,
      confidence,
      key,
    },
  };
}

/**
 * Full offline track analysis: computes multi-band envelopes, beat grid, downbeat,
 * phrase boundaries, and entry/exit cue ratings.
 */
export function analyzeTrackCues(
  channelData: Float32Array,
  sampleRate: number,
): { bpm: number | null; cues: TrackCues } {
  const envelopes = computeBandEnvelopes(channelData, sampleRate);
  return analyzeTrackCuesFromEnvelopes(envelopes, detectKey(channelData, sampleRate));
}

export function findCueSpot(spots: CueSpot[], bar: number | null): CueSpot | null {
  if (spots.length === 0) return null;
  if (bar !== null) {
    const found = spots.find((s) => s.bar === bar);
    if (found) return found;
  }
  return spots[0] ?? null;
}

/**
 * Returns the live deck's active exit flag: normally `bestExitBar`, advancing to the
 * next good (then ok, then any) exit if the playhead has passed the suggested flag.
 * Returns null once no exit lies ahead, so callers fall back to the end-of-track trigger.
 */
export function getActiveExitSpot(
  cues: TrackCues | null,
  currentTimeSec: number,
): CueSpot | null {
  if (!cues || cues.exits.length === 0) return null;
  const suggested = findCueSpot(cues.exits, cues.bestExitBar);
  if (suggested && currentTimeSec <= suggested.sec + 0.05) {
    return suggested;
  }

  const upcomingGood = cues.exits.find(
    (s) => s.sec > currentTimeSec + 0.05 && s.quality === "good",
  );
  if (upcomingGood) return upcomingGood;

  const upcomingOk = cues.exits.find(
    (s) => s.sec > currentTimeSec + 0.05 && s.quality === "ok",
  );
  if (upcomingOk) return upcomingOk;

  const upcomingAny = cues.exits.find((s) => s.sec > currentTimeSec + 0.05);
  return upcomingAny ?? null;
}

/**
 * Computes the timestamp of the next bar downbeat (beat 1) strictly after `currentTimeSec`
 * (at most one bar ahead).
 */
export function getNextBeatOneSec(grid: BeatGrid, currentTimeSec: number): number {
  const barSec = (4 * 60) / grid.bpm;
  if (currentTimeSec < grid.firstDownbeatSec - 0.01) {
    return grid.firstDownbeatSec;
  }
  const barsElapsed = Math.floor((currentTimeSec - grid.firstDownbeatSec) / barSec);
  return grid.firstDownbeatSec + (barsElapsed + 1) * barSec;
}

/**
 * Evaluates the exit quality of the phrase containing `timeSec` (used to tint Fade to X).
 */
export function getExitQualityAtTime(cues: TrackCues | null, timeSec: number): SpotQuality {
  if (!cues || !cues.grid || cues.exits.length === 0) return "ok";
  let active = cues.exits[0];
  for (const spot of cues.exits) {
    if (spot.sec <= timeSec + 0.1) {
      active = spot;
    } else {
      break;
    }
  }
  return active?.quality ?? "ok";
}

/**
 * Estimates tempo (BPM) from a mono PCM Float32Array using a ~100 Hz energy-onset
 * envelope + autocorrelation over the whole track across the 70–175 BPM range.
 */
export function estimateBpm(channelData: Float32Array, sampleRate: number): number | null {
  if (channelData.length < sampleRate * 4 || sampleRate <= 0) return null;

  const hop = Math.max(1, Math.round(sampleRate / 100));
  const envRate = sampleRate / hop;
  const envLen = Math.floor(channelData.length / hop);
  if (envLen < 300) return null;

  const env = new Float32Array(envLen);
  for (let i = 0; i < envLen; i++) {
    const base = i * hop;
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

  const { onset, mean } = buildOnsetEnvelope(env);
  if (mean <= 0) return null;

  const res = estimateBpmFromOnset(onset, envRate);
  if (!res || res.peakRatio < 1.2) return null;
  return Math.round(res.bpm);
}

/**
 * Evaluates how smoothly `nextBpm` follows `prevBpm`. Half/double-time fits grade "ok" at best.
 */
export function evaluateBpmFit(prevBpm: number | null, nextBpm: number | null): BpmFit {
  if (!prevBpm || !nextBpm || prevBpm <= 0 || nextBpm <= 0) {
    return { status: "unknown", diffBpm: 0, label: "Analyzing…" };
  }

  // Compare direct, half-time, and double-time ratios
  const candidates = [
    { bpm: nextBpm, ratio: 1 },
    { bpm: nextBpm * 2, ratio: 2 },
    { bpm: nextBpm * 0.5, ratio: 0.5 },
  ];
  let bestPct = Number.POSITIVE_INFINITY;
  let signedDiff = Math.round(nextBpm - prevBpm);
  let ratio = 1;

  for (const cand of candidates) {
    const pct = Math.abs(cand.bpm - prevBpm) / prevBpm;
    if (pct < bestPct) {
      bestPct = pct;
      signedDiff = Math.round(cand.bpm - prevBpm);
      ratio = cand.ratio;
    }
  }

  const sign = signedDiff > 0 ? "+" : "";
  if (bestPct > 0.14) {
    return { status: "clash", diffBpm: signedDiff, label: `Big jump (${sign}${signedDiff})` };
  }
  // A half/double-time fit can be beat-synced, but it changes the feel: never grade it green.
  if (ratio !== 1) {
    return {
      status: "ok",
      diffBpm: signedDiff,
      label: ratio === 2 ? `Half-time (${sign}${signedDiff})` : `Double-time (${sign}${signedDiff})`,
    };
  }
  if (bestPct <= 0.06) {
    return {
      status: "good",
      diffBpm: signedDiff,
      label: signedDiff === 0 ? "Exact match" : `Smooth (${sign}${signedDiff})`,
    };
  }
  return { status: "ok", diffBpm: signedDiff, label: `Shift (${sign}${signedDiff})` };
}

export interface BpmTrackCandidate {
  id: string;
  bpm: number | null;
  cues: { key: MusicalKey | null } | null;
}

/**
 * Picks a random unplayed song from the library preferring cached BPMs that
 * match `referenceBpm` closely ("good" ±6% first, then "ok" ±14%, then fallback).
 */
export function pickAutoNextTrack<T extends BpmTrackCandidate>(
  tracks: T[],
  options: {
    referenceBpm: number | null;
    /** Key of the track being mixed out of; compatible keys are preferred. */
    referenceKey: MusicalKey | null;
    playedIds: Set<string>;
    excludeIds: Set<string>;
    random?: () => number;
  },
): T | null {
  const { referenceBpm, referenceKey, playedIds, excludeIds, random = Math.random } = options;
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
    const goodInKey = good.filter((t) => keyFit(referenceKey, t.cues?.key ?? null) === "match");
    if (goodInKey.length > 0) return pickRandom(goodInKey);
    if (good.length > 0) return pickRandom(good);

    const ok = withBpm.filter((t) => evaluateBpmFit(referenceBpm, t.bpm).status === "ok");
    if (ok.length > 0) return pickRandom(ok);

    if (withBpm.length > 0) return pickRandom(withBpm);
  }

  return pickRandom(pool);
}

export type MixMode = "smart" | "bass-swap" | "classic";

export type TransitionTechnique =
  | "sync-bass-swap"
  | "filter-sweep"
  | "echo-out"
  | "bass-swap"
  | "classic";

/** Mix lengths the DJ can pick, in bars of the outgoing track. */
export const FADE_BAR_OPTIONS = [8, 16, 32] as const;
export type FadeBars = (typeof FADE_BAR_OPTIONS)[number];
/** Tempo assumed for bar-based timing when a track has no BPM yet. */
const FALLBACK_TIMING_BPM = 125;

export interface TransitionPlan {
  technique: TransitionTechnique;
  durationMs: number;
  /** Mix length in bars of the outgoing track. */
  fadeBars: number;
  label: string;
  /** Starting playbackRate for the incoming deck (1.0 when unsynced). */
  initialPlaybackRate: number;
  /** Incoming beats per outgoing beat used for tempo sync (1, 2 or 0.5); null when unsynced. */
  tempoMultiplier: number | null;
  /** Outgoing BPM-synced echo delay in seconds (0 when unused). */
  echoDelaySec: number;
}

export interface DeckTransitionDsp {
  /** Crossfade dry gain in [0, 1]. */
  gain: number;
  /** Low-shelf EQ gain in dB at 200 Hz ([-20, 0]). */
  bassDb: number;
  /** High-pass cutoff in Hz ([20, 1400], 20 Hz = transparent). */
  hpfHz: number;
  /** Parallel echo send gain ([0, 0.7]). */
  echoSend: number;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function smoothstep(v: number): number {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
}

function echoDelayForBpm(fromBpm: number | null): number {
  return fromBpm && fromBpm > 0
    ? Math.min(0.65, Math.max(0.22, (60 / fromBpm) * 0.75))
    : 0.375;
}

/** Milliseconds `bars` bars last at `fromBpm` (the fallback tempo when it is unknown). */
export function barFadeDurationMs(fromBpm: number | null, bars: number): number {
  const bpm = fromBpm && fromBpm > 0 ? fromBpm : FALLBACK_TIMING_BPM;
  return Math.round(bars * ((4 * 60) / bpm) * 1000);
}

/**
 * Chooses the transition technique, bar-aligned length, tempo-sync ratio and echo delay.
 *
 * Smart mode always blends over whole bars when it can: the DJ's chosen length for a
 * clean pair, a short 4-bar bass swap when a spot is risky or the keys clash, and an
 * echo-out only when the
 * tempos clash or there is no trustworthy beat grid.
 */
export function planMixTransition(options: {
  mode: MixMode;
  /** Outgoing tempo; pass the beat grid's BPM when available (0.1 BPM precision). */
  fromBpm: number | null;
  toBpm: number | null;
  fadeBars: FadeBars;
  /** Bars the outgoing track has left after the mix starts; the mix never outlasts them. */
  barsAvailable?: number;
  confidence?: "high" | "low";
  exitQuality?: SpotQuality | null;
  entryQuality?: SpotQuality | null;
  /** Harmonic fit of the two keys; a clash keeps the overlap short. */
  keyFit?: KeyFit;
}): TransitionPlan {
  const {
    mode,
    fromBpm,
    toBpm,
    fadeBars,
    barsAvailable,
    confidence,
    exitQuality,
    entryQuality,
    keyFit: harmonicFit,
  } = options;
  const bars = (wanted: number) => {
    // Keep an even bar count so the bass swap lands on the middle bar line.
    const cap = barsAvailable === undefined ? wanted : Math.floor(barsAvailable / 2) * 2;
    const n = Math.max(2, Math.min(wanted, cap));
    return { fadeBars: n, durationMs: barFadeDurationMs(fromBpm, n) };
  };

  if (mode === "classic") {
    return {
      technique: "classic",
      ...bars(fadeBars),
      label: "Classic fade",
      initialPlaybackRate: 1,
      tempoMultiplier: null,
      echoDelaySec: 0,
    };
  }

  const sync = tempoSync(fromBpm, toBpm);

  if (mode === "bass-swap") {
    return {
      technique: "bass-swap",
      ...bars(fadeBars),
      label: "Bass swap",
      initialPlaybackRate: 1,
      tempoMultiplier: null,
      echoDelaySec: 0,
    };
  }

  const fit = evaluateBpmFit(fromBpm, toBpm);
  if (confidence === "low" || fit.status === "clash" || !fromBpm) {
    return {
      technique: "echo-out",
      ...bars(2),
      label: "Echo out",
      initialPlaybackRate: 1,
      tempoMultiplier: null,
      echoDelaySec: echoDelayForBpm(fromBpm),
    };
  }

  const risky = exitQuality === "risky" || entryQuality === "risky" || harmonicFit === "clash";

  if (sync) {
    return {
      technique: "sync-bass-swap",
      ...bars(risky ? 4 : fadeBars),
      label: risky ? "Quick bass swap" : sync.rate !== 1 ? "Sync · Bass swap" : "Bass swap",
      initialPlaybackRate: sync.rate,
      tempoMultiplier: sync.multiplier,
      echoDelaySec: 0,
    };
  }

  return {
    technique: "filter-sweep",
    ...bars(risky ? 4 : Math.min(fadeBars, 8)),
    label: "Filter sweep",
    initialPlaybackRate: 1,
    tempoMultiplier: null,
    echoDelaySec: 0,
  };
}

/**
 * Playback rate that matches the incoming tempo to the outgoing one (direct, half or
 * double time), or null when the tempos are more than 6% apart.
 */
function tempoSync(
  fromBpm: number | null,
  toBpm: number | null,
): { rate: number; multiplier: number } | null {
  if (!fromBpm || !toBpm || fromBpm <= 0 || toBpm <= 0) return null;
  let best: { rate: number; multiplier: number; pct: number } | null = null;
  for (const multiplier of [1, 2, 0.5]) {
    const pct = Math.abs(toBpm * multiplier - fromBpm) / fromBpm;
    if (!best || pct < best.pct) best = { rate: fromBpm / (toBpm * multiplier), multiplier, pct };
  }
  if (!best || best.pct > 0.06) return null;
  return { rate: Math.abs(best.rate - 1) < 0.0005 ? 1 : best.rate, multiplier: best.multiplier };
}

/** Largest speed change the phase lock may apply on top of the tempo-sync rate. */
const PHASE_LOCK_MAX_NUDGE = 0.01;
/** Beat offsets below this are left alone so audio-clock jitter does not wobble the tempo. */
const PHASE_LOCK_DEADBAND_SEC = 0.006;

/**
 * Phase lock for a blend: returns the incoming deck's playbackRate that pulls its beats
 * back onto the outgoing deck's beats. Positive offset (incoming early) slows it down;
 * each call corrects half the offset per second of playback, capped at ±1% speed.
 */
export function phaseLockRate(options: {
  baseRate: number;
  tempoMultiplier: number;
  outGrid: BeatGrid;
  outTimeSec: number;
  outRate: number;
  inGrid: BeatGrid;
  inTimeSec: number;
}): { rate: number; offsetSec: number } {
  const { baseRate, tempoMultiplier, outGrid, outTimeSec, outRate, inGrid, inTimeSec } = options;
  const outBeat = 60 / outGrid.bpm;
  const inBeat = 60 / (inGrid.bpm * tempoMultiplier);
  const frac = (v: number) => v - Math.floor(v);
  const outPhase = frac((outTimeSec - outGrid.firstDownbeatSec) / outBeat);
  const inPhase = frac((inTimeSec - inGrid.firstDownbeatSec) / inBeat);
  const diffBeats = frac(inPhase - outPhase + 0.5) - 0.5;
  const offsetSec = (diffBeats * outBeat) / (outRate || 1);
  if (Math.abs(offsetSec) < PHASE_LOCK_DEADBAND_SEC) return { rate: baseRate, offsetSec };
  const nudge = Math.max(-PHASE_LOCK_MAX_NUDGE, Math.min(PHASE_LOCK_MAX_NUDGE, offsetSec / 2));
  return { rate: baseRate * (1 - nudge), offsetSec };
}

/** Tempo to plan a mix with: the beat grid's precise BPM, else the rounded track BPM. */
export function mixTempo(cues: TrackCues | null, bpm: number | null): number | null {
  return cues?.grid?.bpm ?? bpm;
}

/**
 * Evaluates per-deck dry gain, low-shelf bass EQ, high-pass filter cutoff, and
 * parallel echo send at normalized transition progress `p` in [0, 1].
 */
export function computeTransitionDsp(
  technique: TransitionTechnique,
  progress: number,
  fadeBars: number,
): { outgoing: DeckTransitionDsp; incoming: DeckTransitionDsp } {
  const p = clamp01(progress);

  if (technique === "classic") {
    return {
      outgoing: {
        gain: Math.cos(p * Math.PI * 0.5),
        bassDb: 0,
        hpfHz: 20,
        echoSend: 0,
      },
      incoming: {
        gain: Math.sin(p * Math.PI * 0.5),
        bassDb: 0,
        hpfHz: 20,
        echoSend: 0,
      },
    };
  }

  if (technique === "bass-swap" || technique === "sync-bass-swap") {
    // DJ-style blend: the incoming track rises to full volume over the first 40% with its
    // bass cut while the outgoing track holds at full; the bass swaps over one beat on the
    // middle bar line; only then does the outgoing track fade away.
    const swapAt = 0.5;
    const swapWidth = 1 / (4 * Math.max(1, fadeBars));
    const swap = smoothstep((p - swapAt) / swapWidth);
    const outFade = smoothstep((p - swapAt) / (1 - swapAt));
    const tailLift = smoothstep((p - 0.7) / 0.3);
    return {
      outgoing: {
        gain: Math.cos(outFade * Math.PI * 0.5),
        bassDb: -20 * swap,
        hpfHz: 20 + 260 * tailLift,
        echoSend: 0,
      },
      incoming: {
        gain: Math.sin(clamp01(p / 0.4) * Math.PI * 0.5),
        bassDb: -20 * (1 - swap),
        hpfHz: 20,
        echoSend: 0,
      },
    };
  }

  if (technique === "filter-sweep") {
    // Exponential high-pass sweep (20 Hz -> 1100 Hz) lifts outgoing track away cleanly
    const hpfCurve = smoothstep((p - 0.08) / 0.87);
    const outHpf = 20 * 55 ** hpfCurve;
    const outBassCut = -18 * smoothstep(p / 0.55);
    const inBassOpen = smoothstep((p - 0.25) / 0.3);
    const inGain = Math.sin(clamp01(p / 0.85) * Math.PI * 0.5);

    return {
      outgoing: {
        gain: Math.cos(p * Math.PI * 0.5),
        bassDb: outBassCut,
        hpfHz: outHpf,
        echoSend: 0,
      },
      incoming: {
        gain: inGain,
        bassDb: -14 * (1 - inBassOpen),
        hpfHz: 20,
        echoSend: 0,
      },
    };
  }

  // "echo-out": short club echo wash on outgoing track while incoming drops with full punch
  const echoRise = Math.sin(clamp01(p / 0.38) * Math.PI * 0.5);
  const echoCut = 1 - smoothstep((p - 0.4) / 0.16);
  const echoSend = 0.62 * echoRise * echoCut;

  const outFade = smoothstep((p - 0.12) / 0.52);
  const outHpf = 20 * 60 ** smoothstep((p - 0.05) / 0.65);
  const inDrop = smoothstep((p - 0.32) / 0.42);

  return {
    outgoing: {
      gain: Math.cos(outFade * Math.PI * 0.5),
      bassDb: -18 * smoothstep(p / 0.35),
      hpfHz: outHpf,
      echoSend,
    },
    incoming: {
      gain: Math.sin(inDrop * Math.PI * 0.5),
      bassDb: 0,
      hpfHz: 20,
      echoSend: 0,
    },
  };
}
