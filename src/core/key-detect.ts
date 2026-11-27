/**
 * Musical key detection for harmonic mixing.
 *
 * Builds an average chroma vector (energy per pitch class) from log-magnitude spectra of
 * the mono analysis decode, then correlates it with major/minor key profiles rotated to
 * all 12 tonics. The result is reported in Camelot notation (1A–12B), which DJs use to
 * read key compatibility at a glance.
 */

export interface MusicalKey {
  /** Pitch class of the tonic, 0 = C … 11 = B. */
  tonic: number;
  mode: "major" | "minor";
  /** Camelot wheel code, e.g. "8A" (A minor) or "8B" (C major). */
  camelot: string;
  /** Margin between the best and runner-up key correlations (0 = ambiguous). */
  strength: number;
}

export type KeyFit = "match" | "clash" | "unknown";

const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

// Krumhansl–Kessler probe-tone profiles, tonic first.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Camelot number for each tonic pitch class (major = B side, minor = A side).
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

const FFT_SIZE = 8192;
// Tuned on CC-licensed dance tracks against Essentia's KeyExtractor: bass harmonics below
// 100 Hz are poorly resolved at this FFT size and mostly add kick-drum noise.
const MIN_FREQ_HZ = 100;
const MAX_FREQ_HZ = 2500;
/** Below this correlation margin the key is too ambiguous to judge compatibility. */
const MIN_KEY_STRENGTH = 0.02;

export function keyName(key: MusicalKey): string {
  return `${PITCH_NAMES[key.tonic] ?? "?"}${key.mode === "minor" ? "m" : ""}`;
}

/**
 * Detects the dominant key of a mono PCM buffer. Returns null for silent or very short
 * input. Analyses about one frame per second, so a 10-minute track costs ~600 FFTs.
 */
export function detectKey(channelData: Float32Array, sampleRate: number): MusicalKey | null {
  if (sampleRate <= 0 || channelData.length < FFT_SIZE * 4) return null;

  const chroma = new Float64Array(12);
  const window = hannWindow(FFT_SIZE);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const hop = Math.max(FFT_SIZE, Math.floor(sampleRate));
  let frames = 0;

  for (let start = 0; start + FFT_SIZE <= channelData.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const v = (channelData[start + i] ?? 0) * (window[i] ?? 0);
      re[i] = v;
      im[i] = 0;
      energy += v * v;
    }
    if (energy < 1e-6) continue;
    fft(re, im);

    const frame = spectralPeakChroma(re, im, sampleRate);
    // Normalise each frame so loud sections do not dominate the track's key.
    let max = 0;
    for (const v of frame) max = Math.max(max, v);
    if (max <= 0) continue;
    for (let pc = 0; pc < 12; pc++) chroma[pc] = (chroma[pc] ?? 0) + (frame[pc] ?? 0) / max;
    frames++;
  }

  if (frames < 4) return null;
  return keyFromChroma(chroma);
}

/** Picks the best-correlating major/minor key for a 12-bin chroma vector. */
export function keyFromChroma(chroma: ArrayLike<number>): MusicalKey | null {
  const scores: { tonic: number; mode: "major" | "minor"; r: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    scores.push({ tonic, mode: "major", r: rotatedCorrelation(chroma, MAJOR_PROFILE, tonic) });
    scores.push({ tonic, mode: "minor", r: rotatedCorrelation(chroma, MINOR_PROFILE, tonic) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  const second = scores[1];
  if (!best || !second || !Number.isFinite(best.r)) return null;
  return {
    tonic: best.tonic,
    mode: best.mode,
    camelot: camelotCode(best.tonic, best.mode),
    strength: Math.round((best.r - second.r) * 1000) / 1000,
  };
}

export function camelotCode(tonic: number, mode: "major" | "minor"): string {
  const table = mode === "major" ? CAMELOT_MAJOR : CAMELOT_MINOR;
  return `${table[tonic] ?? 0}${mode === "major" ? "B" : "A"}`;
}

/**
 * Harmonic compatibility on the Camelot wheel: same code, ±1 on the same letter, or the
 * relative major/minor (same number) mix cleanly. Anything else clashes.
 */
export function keyFit(a: MusicalKey | null, b: MusicalKey | null): KeyFit {
  if (!a || !b || a.strength < MIN_KEY_STRENGTH || b.strength < MIN_KEY_STRENGTH) {
    return "unknown";
  }
  const numA = Number.parseInt(a.camelot, 10);
  const numB = Number.parseInt(b.camelot, 10);
  if (a.mode !== b.mode) return numA === numB ? "match" : "clash";
  const step = Math.abs(numA - numB) % 12;
  return step === 0 || step === 1 || step === 11 ? "match" : "clash";
}

function rotatedCorrelation(chroma: ArrayLike<number>, profile: number[], tonic: number): number {
  let meanC = 0;
  let meanP = 0;
  for (let i = 0; i < 12; i++) {
    meanC += chroma[i] ?? 0;
    meanP += profile[i] ?? 0;
  }
  meanC /= 12;
  meanP /= 12;
  let num = 0;
  let denC = 0;
  let denP = 0;
  for (let i = 0; i < 12; i++) {
    const c = (chroma[(i + tonic) % 12] ?? 0) - meanC;
    const p = (profile[i] ?? 0) - meanP;
    num += c * p;
    denC += c * c;
    denP += p * p;
  }
  const den = Math.sqrt(denC * denP);
  return den > 0 ? num / den : Number.NaN;
}

/**
 * Chroma of one FFT frame from its spectral peaks only: broadband drum energy between
 * partials is ignored, each peak's frequency is refined by parabolic interpolation, and
 * its magnitude is shared towards the nearest semitone with a cos² weight.
 */
function spectralPeakChroma(re: Float64Array, im: Float64Array, sampleRate: number): Float64Array {
  const frame = new Float64Array(12);
  const binHz = sampleRate / FFT_SIZE;
  const lo = Math.max(2, Math.ceil(MIN_FREQ_HZ / binHz));
  const hi = Math.min(FFT_SIZE / 2 - 2, Math.floor(MAX_FREQ_HZ / binHz));
  const mag = (k: number) => Math.hypot(re[k] ?? 0, im[k] ?? 0);
  let prev = mag(lo - 1);
  let curr = mag(lo);
  for (let k = lo; k <= hi; k++) {
    const next = mag(k + 1);
    if (curr > prev && curr >= next) {
      const denom = prev - 2 * curr + next;
      const offset = denom !== 0 ? (0.5 * (prev - next)) / denom : 0;
      const midi = 69 + 12 * Math.log2(((k + offset) * binHz) / 440);
      const nearest = Math.round(midi);
      const weight = Math.cos((midi - nearest) * Math.PI) ** 2;
      const pc = ((nearest % 12) + 12) % 12;
      frame[pc] = (frame[pc] ?? 0) + curr * weight;
    }
    prev = curr;
    curr = next;
  }
  return frame;
}

function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/** In-place iterative radix-2 FFT; `re.length` must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] ?? 0, re[i] ?? 0];
      [im[i], im[j]] = [im[j] ?? 0, im[i] ?? 0];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const cos = Math.cos(step * k);
        const sin = Math.sin(step * k);
        const a = start + k;
        const b = a + half;
        const tre = (re[b] ?? 0) * cos - (im[b] ?? 0) * sin;
        const tim = (re[b] ?? 0) * sin + (im[b] ?? 0) * cos;
        re[b] = (re[a] ?? 0) - tre;
        im[b] = (im[a] ?? 0) - tim;
        re[a] = (re[a] ?? 0) + tre;
        im[a] = (im[a] ?? 0) + tim;
      }
    }
  }
}
