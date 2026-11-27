import { describe, expect, test } from "bun:test";
import {
  analyzeTrackCues,
  computeBandEnvelopes,
  computeTransitionDsp,
  computeWaveformAndAutoGain,
  detectBeatGrid,
  equalPowerGains,
  estimateBpm,
  evaluateBpmFit,
  findCueSpot,
  formatTime,
  getActiveExitSpot,
  TRACK_CUES_VERSION,
  getExitQualityAtTime,
  getIdleDeck,
  getLiveDeck,
  getNextBeatOneSec,
  isAudioFile,
  isDeckFadedOut,
  parseFilenameMetadata,
  pickAutoNextTrack,
  planMixTransition,
  phaseLockRate,
  barFadeDurationMs,
} from "@/core/dj-math";

describe("equalPowerGains", () => {
  test("full left is Deck A only", () => {
    const { gainA, gainB } = equalPowerGains(0);
    expect(gainA).toBeCloseTo(1, 5);
    expect(gainB).toBeCloseTo(0, 5);
  });

  test("full right is Deck B only", () => {
    const { gainA, gainB } = equalPowerGains(1);
    expect(gainA).toBeCloseTo(0, 5);
    expect(gainB).toBeCloseTo(1, 5);
  });

  test("center preserves constant power (gainA^2 + gainB^2 === 1)", () => {
    const { gainA, gainB } = equalPowerGains(0.5);
    expect(gainA * gainA + gainB * gainB).toBeCloseTo(1, 5);
  });
});

describe("computeWaveformAndAutoGain", () => {
  test("produces requested bar count normalized to [0.06, 1]", () => {
    const samples = new Float32Array(1600);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin(i * 0.1) * 0.2;
    }
    const { peaks, autoGain } = computeWaveformAndAutoGain(samples, 40);
    expect(peaks).toHaveLength(40);
    expect(Math.max(...peaks)).toBeCloseTo(1, 2);
    expect(autoGain).toBeGreaterThanOrEqual(0.5);
    expect(autoGain).toBeLessThanOrEqual(1.8);
  });

  test("boosts quiet tracks and attenuates loud tracks within clamp", () => {
    const quiet = new Float32Array(1000).fill(0.05);
    const loud = new Float32Array(1000).fill(0.9);
    expect(computeWaveformAndAutoGain(quiet, 20).autoGain).toBeGreaterThan(1.2);
    expect(computeWaveformAndAutoGain(loud, 20).autoGain).toBeLessThan(0.8);
  });
});

describe("formatTime & filename helpers", () => {
  test("formats seconds cleanly", () => {
    expect(formatTime(0)).toBe("00:00");
    expect(formatTime(125)).toBe("02:05");
    expect(formatTime(-5)).toBe("00:00");
    expect(formatTime(Number.NaN)).toBe("00:00");
  });

  test("parses Artist - Title filenames", () => {
    expect(parseFilenameMetadata("01 - Daft Punk - Get Lucky.mp3")).toEqual({
      artist: "Daft Punk",
      title: "Get Lucky",
    });
    expect(parseFilenameMetadata("Midnight City.flac")).toEqual({
      artist: "Unknown Artist",
      title: "Midnight City",
    });
  });

  test("recognizes supported audio extensions and rejects macOS ._ resource forks", () => {
    expect(isAudioFile("track.mp3")).toBe(true);
    expect(isAudioFile("track.FLAC")).toBe(true);
    expect(isAudioFile("cover.jpg")).toBe(false);
    expect(isAudioFile("._track.mp3")).toBe(false);
    expect(isAudioFile("Music/._Greek Song.mp3")).toBe(false);
    expect(isAudioFile(".DS_Store")).toBe(false);
  });
});

describe("live & idle deck guards", () => {
  test("identifies live and idle decks accurately", () => {
    expect(getLiveDeck(0, true, false)).toBe("A");
    expect(getIdleDeck(0, true, false)).toBe("B");
    expect(getLiveDeck(1, false, true)).toBe("B");
    expect(getIdleDeck(1, false, true)).toBe("A");
    expect(getLiveDeck(0.2, true, true)).toBe("A");
  });

  test("identifies faded-out decks accurately", () => {
    expect(isDeckFadedOut("B", 0)).toBe(true);
    expect(isDeckFadedOut("A", 0)).toBe(false);
    expect(isDeckFadedOut("A", 1)).toBe(true);
    expect(isDeckFadedOut("B", 1)).toBe(false);
    expect(isDeckFadedOut("A", 0.5)).toBe(false);
    expect(isDeckFadedOut("B", 0.5)).toBe(false);
  });
});

describe("BPM detection & transition fit", () => {
  test("detects synthetic 120 BPM beat train accurately", () => {
    const sr = 22050;
    const durationSec = 10;
    const pcm = new Float32Array(sr * durationSec);
    const beatInterval = Math.round(sr * 0.5); // 120 BPM = 0.5s per beat
    for (let pos = 0; pos < pcm.length; pos += beatInterval) {
      for (let k = 0; k < 400 && pos + k < pcm.length; k++) {
        pcm[pos + k] = Math.sin(k * 0.2) * (1 - k / 400);
      }
    }
    const bpm = estimateBpm(pcm, sr);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm ?? 0) - 120)).toBeLessThanOrEqual(2);
  });

  test("classifies smooth, shift, clash, and half-time fits", () => {
    expect(evaluateBpmFit(120, 124).status).toBe("good");
    expect(evaluateBpmFit(120, 132).status).toBe("ok");
    expect(evaluateBpmFit(95, 140).status).toBe("clash");
    expect(evaluateBpmFit(150, 75).status).toBe("good"); // half-time matches!
    expect(evaluateBpmFit(120, null).status).toBe("unknown");
  });
});

describe("pickAutoNextTrack", () => {
  test("prefers unplayed cached tracks with close BPM", () => {
    const tracks = [
      { id: "live", bpm: 120 },
      { id: "played-good", bpm: 122 },
      { id: "far", bpm: 165 },
      { id: "close", bpm: 124 },
      { id: "uncached", bpm: null },
    ];
    const picked = pickAutoNextTrack(tracks, {
      referenceBpm: 120,
      playedIds: new Set(["played-good"]),
      excludeIds: new Set(["live"]),
      random: () => 0,
    });
    expect(picked?.id).toBe("close");
  });

  test("falls back to shift-range BPM when no exact/smooth match exists", () => {
    const tracks = [
      { id: "live", bpm: 120 },
      { id: "shift", bpm: 132 },
      { id: "clash", bpm: 165 },
    ];
    const picked = pickAutoNextTrack(tracks, {
      referenceBpm: 120,
      playedIds: new Set(),
      excludeIds: new Set(["live"]),
      random: () => 0,
    });
    expect(picked?.id).toBe("shift");
  });
});

describe("Smart Mix planner & DSP curves", () => {
  const smart = (over: Partial<Parameters<typeof planMixTransition>[0]> = {}) =>
    planMixTransition({
      mode: "smart",
      fromBpm: 124,
      toBpm: 120,
      fadeBars: 16,
      confidence: "high",
      exitQuality: "good",
      entryQuality: "good",
      ...over,
    });

  test("blends close tempos over the chosen bars with a precise sync rate", () => {
    const plan = smart({ fromBpm: 124.3, toBpm: 120.1 });
    expect(plan.technique).toBe("sync-bass-swap");
    expect(plan.fadeBars).toBe(16);
    expect(plan.initialPlaybackRate).toBeCloseTo(124.3 / 120.1, 5);
    expect(plan.tempoMultiplier).toBe(1);
    expect(plan.durationMs).toBe(Math.round(16 * (240 / 124.3) * 1000));
  });

  test("syncs half-time tracks with a tempo multiplier of 2", () => {
    const plan = smart({ fromBpm: 128, toBpm: 64 });
    expect(plan.technique).toBe("sync-bass-swap");
    expect(plan.tempoMultiplier).toBe(2);
    expect(plan.initialPlaybackRate).toBe(1);
  });

  test("a risky spot shortens the blend to 4 bars instead of an echo", () => {
    for (const over of [{ exitQuality: "risky" as const }, { entryQuality: "risky" as const }]) {
      const plan = smart(over);
      expect(plan.technique).toBe("sync-bass-swap");
      expect(plan.fadeBars).toBe(4);
    }
  });

  test("echo-out only for tempo clashes, low confidence or unknown tempo", () => {
    for (const over of [
      { toBpm: 92 },
      { confidence: "low" as const },
      { fromBpm: null },
    ]) {
      const plan = smart(over);
      expect(plan.technique).toBe("echo-out");
      expect(plan.fadeBars).toBe(2);
    }
    expect(smart({ fromBpm: 120, toBpm: 92 }).echoDelaySec).toBeCloseTo(0.375, 3);
  });

  test("moderate tempo gaps filter-sweep over at most 8 bars, unsynced", () => {
    const plan = smart({ fromBpm: 120, toBpm: 132, fadeBars: 32 });
    expect(plan.technique).toBe("filter-sweep");
    expect(plan.fadeBars).toBe(8);
    expect(plan.initialPlaybackRate).toBe(1);
    expect(plan.tempoMultiplier).toBeNull();
  });

  test("never plans a mix longer than the outgoing track has left, in even bars", () => {
    expect(smart({ fadeBars: 32, barsAvailable: 19.7 }).fadeBars).toBe(18);
    expect(smart({ fadeBars: 8, barsAvailable: 40 }).fadeBars).toBe(8);
    expect(smart({ fadeBars: 16, barsAvailable: 1 }).fadeBars).toBe(2);
  });

  test("respects explicit bass-swap and classic modes with the chosen bars", () => {
    const swap = planMixTransition({ mode: "bass-swap", fromBpm: 90, toBpm: 140, fadeBars: 8 });
    expect(swap.technique).toBe("bass-swap");
    expect(swap.fadeBars).toBe(8);
    const classic = planMixTransition({ mode: "classic", fromBpm: null, toBpm: 122, fadeBars: 8 });
    expect(classic.technique).toBe("classic");
    expect(classic.durationMs).toBe(barFadeDurationMs(null, 8));
  });

  test("bass swap: incoming reaches full volume early, outgoing holds until the swap", () => {
    const early = computeTransitionDsp("sync-bass-swap", 0.4, 16);
    expect(early.incoming.gain).toBeCloseTo(1, 3);
    expect(early.outgoing.gain).toBeCloseTo(1, 3);
    expect(early.incoming.bassDb).toBeLessThan(-19);
    expect(early.outgoing.bassDb).toBeCloseTo(0, 3);

    const quarter = computeTransitionDsp("sync-bass-swap", 0.2, 16);
    expect(quarter.incoming.gain).toBeGreaterThan(0.6);
    expect(quarter.incoming.gain).toBeLessThan(0.8);

    const end = computeTransitionDsp("sync-bass-swap", 1, 16);
    expect(end.outgoing.gain).toBeCloseTo(0, 3);
    expect(end.incoming.gain).toBeCloseTo(1, 3);
  });

  test("bass swap happens within one beat starting on the middle bar line", () => {
    const bars = 16;
    const beat = 1 / (4 * bars);
    const before = computeTransitionDsp("sync-bass-swap", 0.5 - 0.001, bars);
    const after = computeTransitionDsp("sync-bass-swap", 0.5 + beat, bars);
    expect(before.incoming.bassDb).toBeLessThan(-19.9);
    expect(before.outgoing.bassDb).toBeCloseTo(0, 2);
    expect(after.incoming.bassDb).toBeCloseTo(0, 3);
    expect(after.outgoing.bassDb).toBeCloseTo(-20, 3);
  });

  test("echo-out feeds echo early then cuts send so delay decays cleanly", () => {
    const peak = computeTransitionDsp("echo-out", 0.35, 2);
    const tail = computeTransitionDsp("echo-out", 0.8, 2);
    expect(peak.outgoing.echoSend).toBeGreaterThan(0.4);
    expect(tail.outgoing.echoSend).toBeCloseTo(0, 4);
    expect(tail.incoming.gain).toBeCloseTo(1, 3);
    expect(tail.incoming.bassDb).toBe(0);
  });
});

describe("Phase lock", () => {
  const grid = { bpm: 120, firstDownbeatSec: 0 }; // beat = 0.5 s
  const lock = (inTimeSec: number, outTimeSec = 10, inGrid = grid, tempoMultiplier = 1) =>
    phaseLockRate({
      baseRate: 1.02,
      tempoMultiplier,
      outGrid: grid,
      outTimeSec,
      outRate: 1,
      inGrid,
      inTimeSec,
    });

  test("leaves the rate alone when beats line up or the offset is within jitter", () => {
    expect(lock(20).rate).toBe(1.02);
    expect(lock(20.004).rate).toBe(1.02);
  });

  test("slows an incoming deck that is ahead and speeds one that is behind", () => {
    const ahead = lock(20.012);
    expect(ahead.offsetSec).toBeCloseTo(0.012, 4);
    expect(ahead.rate).toBeCloseTo(1.02 * (1 - 0.006), 5);
    const behind = lock(19.97);
    expect(behind.offsetSec).toBeCloseTo(-0.03, 4);
    expect(behind.rate).toBeGreaterThan(1.02);
  });

  test("caps the nudge at ±1% and wraps offsets to the nearest beat", () => {
    expect(lock(20.2).rate).toBeCloseTo(1.02 * 0.99, 6);
    // 0.45 s ahead is really 0.05 s behind the next beat
    expect(lock(20.45).offsetSec).toBeCloseTo(-0.05, 4);
  });

  test("compares half-time incoming tracks in outgoing beats", () => {
    const half = { bpm: 60, firstDownbeatSec: 0 };
    expect(lock(7.5, 10, half, 2).offsetSec).toBeCloseTo(0, 6);
    expect(lock(7.52, 10, half, 2).offsetSec).toBeCloseTo(0.02, 4);
  });
});

/**
 * Synthesizes a 4/4 click track at 22.05 kHz with a low-frequency kick (75 Hz)
 * accented on beat 1 and lighter hits on beats 2–4, starting at `offsetSec`.
 */
function makeClickTrack(options: {
  bpm: number;
  durationSec: number;
  offsetSec: number;
  sampleRate?: number;
  beat1Gain?: number;
  otherBeatGain?: number;
}): Float32Array {
  const {
    bpm,
    durationSec,
    offsetSec,
    sampleRate = 22050,
    beat1Gain = 0.95,
    otherBeatGain = 0.45,
  } = options;
  const pcm = new Float32Array(Math.floor(sampleRate * durationSec));
  const beatSec = 60 / bpm;
  const kickLen = Math.floor(sampleRate * 0.08); // 80 ms kick envelope

  for (let beat = 0; ; beat++) {
    const t = offsetSec + beat * beatSec;
    if (t >= durationSec - 0.1) break;
    const startSample = Math.round(t * sampleRate);
    const isDownbeat = beat % 4 === 0;
    const gain = isDownbeat ? beat1Gain : otherBeatGain;
    const freq = isDownbeat ? 72 : 110;

    for (let k = 0; k < kickLen && startSample + k < pcm.length; k++) {
      const env = Math.exp((-6 * k) / kickLen);
      const click = isDownbeat ? Math.sin((2 * Math.PI * freq * k) / sampleRate) : Math.sin((2 * Math.PI * freq * k) / sampleRate) * 0.6 + Math.sin((2 * Math.PI * 1200 * k) / sampleRate) * 0.4;
      pcm[startSample + k] = (pcm[startSample + k] ?? 0) + gain * env * click;
    }
  }
  return pcm;
}

describe("Beat grid & downbeat detection", () => {
  test("computes separate low (<150 Hz) and mid (300 Hz–3 kHz) band envelopes", () => {
    const sr = 22050;
    const n = sr * 4;
    const lowTone = new Float32Array(n);
    const midTone = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      lowTone[i] = 0.5 * Math.sin((2 * Math.PI * 75 * i) / sr);
      midTone[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr);
    }

    const lowEnv = computeBandEnvelopes(lowTone, sr);
    const midEnv = computeBandEnvelopes(midTone, sr);

    const midIdx = Math.floor(lowEnv.total.length / 2);
    expect(lowEnv.low[midIdx] ?? 0).toBeGreaterThan((lowEnv.mid[midIdx] ?? 0) * 5);
    expect(midEnv.mid[midIdx] ?? 0).toBeGreaterThan((midEnv.low[midIdx] ?? 0) * 5);
  });

  test("detects 124 BPM click track with 0.35s downbeat offset within ±1 BPM and 30 ms", () => {
    const sr = 22050;
    const pcm = makeClickTrack({ bpm: 124, durationSec: 40, offsetSec: 0.35, sampleRate: sr });
    const res = detectBeatGrid(pcm, sr);

    expect(res.grid).not.toBeNull();
    expect(res.confidence).toBe("high");
    expect(Math.abs((res.grid?.bpm ?? 0) - 124)).toBeLessThanOrEqual(1);
    expect(Math.abs((res.grid?.firstDownbeatSec ?? 0) - 0.35)).toBeLessThanOrEqual(0.03);
  });

  test("detects 128 BPM click track with 1.15s downbeat offset within ±1 BPM and 30 ms", () => {
    const sr = 22050;
    const pcm = makeClickTrack({ bpm: 128, durationSec: 45, offsetSec: 1.15, sampleRate: sr });
    const res = detectBeatGrid(pcm, sr);

    expect(res.grid).not.toBeNull();
    expect(res.confidence).toBe("high");
    expect(Math.abs((res.grid?.bpm ?? 0) - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs((res.grid?.firstDownbeatSec ?? 0) - 1.15)).toBeLessThanOrEqual(0.03);
  });

  test("detects 96 BPM click track after a 4.2s silent intro within ±1 BPM and 30 ms", () => {
    const sr = 22050;
    const pcm = makeClickTrack({ bpm: 96, durationSec: 50, offsetSec: 4.2, sampleRate: sr });
    const res = detectBeatGrid(pcm, sr);

    expect(res.grid).not.toBeNull();
    expect(res.confidence).toBe("high");
    expect(Math.abs((res.grid?.bpm ?? 0) - 96)).toBeLessThanOrEqual(1);
    expect(Math.abs((res.grid?.firstDownbeatSec ?? 0) - 4.2)).toBeLessThanOrEqual(0.03);
  });

  test("detects 140 BPM click track starting at 0.0s within ±1 BPM and 30 ms", () => {
    const sr = 22050;
    const pcm = makeClickTrack({ bpm: 140, durationSec: 36, offsetSec: 0, sampleRate: sr });
    const res = detectBeatGrid(pcm, sr);

    expect(res.grid).not.toBeNull();
    expect(res.confidence).toBe("high");
    expect(Math.abs((res.grid?.bpm ?? 0) - 140)).toBeLessThanOrEqual(1);
    expect(Math.abs(res.grid?.firstDownbeatSec ?? 99)).toBeLessThanOrEqual(0.03);
  });

  test("returns null grid and low confidence for a beatless sustained drone", () => {
    const sr = 22050;
    const pcm = new Float32Array(sr * 20);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / sr);
    }
    const res = detectBeatGrid(pcm, sr);
    expect(res.grid).toBeNull();
    expect(res.confidence).toBe("low");
  });

  test("returns null grid and low confidence for aperiodic noise", () => {
    const sr = 22050;
    const pcm = new Float32Array(sr * 20);
    let seed = 1337;
    for (let i = 0; i < pcm.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      pcm[i] = ((seed / 0xffffffff) * 2 - 1) * 0.35;
    }
    const res = detectBeatGrid(pcm, sr);
    expect(res.grid).toBeNull();
    expect(res.confidence).toBe("low");
  });
});

/**
 * Synthesizes a structured 64-bar track at `bpm` with:
 * - Bars 0..15: instrumental intro (moderate kick, no mid-band vocals)
 * - Bars 16..47: high-energy vocal body (loud kick + sustained 900 Hz / 1.4 kHz vocal proxy)
 * - Bars 48..63: instrumental outro (energy drops, vocals end cleanly)
 */
function makeStructuredTrack(options: {
  bpm: number;
  offsetSec?: number;
  sampleRate?: number;
  introBars?: number;
  bodyBars?: number;
  outroBars?: number;
  /** Sustained mid-band synth bed under every bar, like the pads/guitars of real mixes. */
  padGain?: number;
}): Float32Array {
  const {
    bpm,
    offsetSec = 0.2,
    sampleRate = 22050,
    introBars = 16,
    bodyBars = 32,
    outroBars = 16,
    padGain = 0,
  } = options;
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const totalBars = introBars + bodyBars + outroBars;
  const durationSec = offsetSec + totalBars * barSec + 1.0;
  const pcm = new Float32Array(Math.floor(sampleRate * durationSec));
  const kickLen = Math.floor(sampleRate * 0.09);

  for (let bar = 0; bar < totalBars; bar++) {
    const inIntro = bar < introBars;
    const inBody = bar >= introBars && bar < introBars + bodyBars;
    const barStartSec = offsetSec + bar * barSec;
    const barEndSec = barStartSec + barSec;

    // 4/4 kicks (stronger on beat 1 and louder in body)
    const sectionGain = inBody ? 0.85 : inIntro ? 0.35 : 0.32;
    for (let beat = 0; beat < 4; beat++) {
      const startSample = Math.round((barStartSec + beat * beatSec) * sampleRate);
      const gain = sectionGain * (beat === 0 ? 1.0 : 0.55);
      const freq = beat === 0 ? 70 : 105;
      for (let k = 0; k < kickLen && startSample + k < pcm.length; k++) {
        const env = Math.exp((-5.5 * k) / kickLen);
        pcm[startSample + k] =
          (pcm[startSample + k] ?? 0) + gain * env * Math.sin((2 * Math.PI * freq * k) / sampleRate);
      }
    }

    if (padGain > 0) {
      const s0 = Math.round(barStartSec * sampleRate);
      const s1 = Math.min(pcm.length, Math.round(barEndSec * sampleRate));
      for (let i = s0; i < s1; i++) {
        pcm[i] =
          (pcm[i] ?? 0) +
          padGain * Math.sin((2 * Math.PI * 440 * i) / sampleRate) +
          padGain * 0.7 * Math.sin((2 * Math.PI * 660 * i) / sampleRate);
      }
    }

    // Sustained 300 Hz–3 kHz vocal-band tone across the entire body
    if (inBody) {
      const s0 = Math.round(barStartSec * sampleRate);
      const s1 = Math.min(pcm.length, Math.round(barEndSec * sampleRate));
      for (let i = s0; i < s1; i++) {
        const vocal =
          0.32 * Math.sin((2 * Math.PI * 880 * i) / sampleRate) +
          0.2 * Math.sin((2 * Math.PI * 1450 * i) / sampleRate);
        pcm[i] = (pcm[i] ?? 0) + vocal;
      }
    }
  }

  return pcm;
}

describe("Transition cue analysis (phrase features, ratings, fallback)", () => {
  test("a track with the same vocal-band level throughout is not rated all risky", () => {
    const sr = 22050;
    const pcm = makeStructuredTrack({
      bpm: 124,
      sampleRate: sr,
      introBars: 0,
      bodyBars: 64,
      outroBars: 0,
      padGain: 0.3,
    });
    const { cues } = analyzeTrackCues(pcm, sr);
    expect(cues.entries.some((s) => s.quality !== "risky")).toBe(true);
  });

  test("rates intro good for entry, vocal body risky, and outro good for exit", () => {
    const sr = 22050;
    const pcm = makeStructuredTrack({ bpm: 120, offsetSec: 0.25, sampleRate: sr });
    const { bpm, cues } = analyzeTrackCues(pcm, sr);

    expect(cues.version).toBe(TRACK_CUES_VERSION);
    expect(cues.confidence).toBe("high");
    expect(cues.grid).not.toBeNull();
    expect(Math.abs((bpm ?? 0) - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs((cues.grid?.firstDownbeatSec ?? 0) - 0.25)).toBeLessThanOrEqual(0.03);

    // Phrase starts every 8 bars: 0, 8, 16, 24, 32, 40, 48, 56
    expect(cues.entries.map((s) => s.bar)).toEqual([0, 8, 16, 24, 32, 40, 48, 56]);
    expect(cues.exits.map((s) => s.bar)).toEqual([0, 8, 16, 24, 32, 40, 48, 56]);

    // Intro bar 0 is a good entry and bestEntryBar lies in the clean intro (bars 0 or 8)
    const entryBar0 = findCueSpot(cues.entries, 0);
    expect(entryBar0?.quality).toBe("good");
    expect(cues.bestEntryBar).toBeLessThanOrEqual(8);

    // Mid-body vocal boundaries (bars 24, 32, 40) are risky for both entry and exit
    for (const bar of [24, 32, 40]) {
      expect(findCueSpot(cues.entries, bar)?.quality).toBe("risky");
      expect(findCueSpot(cues.exits, bar)?.quality).toBe("risky");
    }

    // Outro start (bar 48, 16 bars before audible end) is a good exit and chosen as bestExitBar
    const exitBar48 = findCueSpot(cues.exits, 48);
    expect(exitBar48?.quality).toBe("good");
    expect(cues.bestExitBar).toBe(48);

    // Bar 56 only has 8 bars remaining (< 16 bars), so it is not rated good
    expect(findCueSpot(cues.exits, 56)?.quality).not.toBe("good");
  });

  test("falls back to silence-trimmed single entry/exit with low confidence when no grid fits", () => {
    const sr = 22050;
    const pcm = new Float32Array(sr * 30);
    // 3s silence, 22s beatless drone (3s..25s), 5s silence
    for (let i = sr * 3; i < sr * 25; i++) {
      pcm[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / sr);
    }
    const { cues } = analyzeTrackCues(pcm, sr);

    expect(cues.grid).toBeNull();
    expect(cues.confidence).toBe("low");
    expect(cues.entries).toHaveLength(1);
    expect(cues.exits).toHaveLength(1);
    expect(cues.bestEntryBar).toBe(0);
    expect(cues.bestExitBar).toBe(0);
    expect(cues.entries[0]?.sec ?? 0).toBeGreaterThanOrEqual(2.8);
    expect(cues.entries[0]?.sec ?? 0).toBeLessThanOrEqual(3.2);
    expect(cues.exits[0]?.sec ?? 0).toBeGreaterThan(cues.entries[0]?.sec ?? 0);
    expect(cues.exits[0]?.sec ?? 99).toBeLessThan(25);
  });

  test("advances active exit flag to next good exit when playhead passes suggested flag", () => {
    const cues = {
      version: TRACK_CUES_VERSION,
      grid: { bpm: 120, firstDownbeatSec: 0 },
      entries: [],
      exits: [
        { bar: 16, sec: 32, quality: "risky" as const, reason: "vocals" },
        { bar: 32, sec: 64, quality: "good" as const, reason: "breakdown" },
        { bar: 40, sec: 80, quality: "risky" as const, reason: "vocals" },
        { bar: 48, sec: 96, quality: "good" as const, reason: "outro" },
        { bar: 56, sec: 112, quality: "ok" as const, reason: "short outro" },
      ],
      bestEntryBar: 0,
      bestExitBar: 32,
      confidence: "high" as const,
    };

    expect(getActiveExitSpot(cues, 20)?.bar).toBe(32);
    expect(getActiveExitSpot(cues, 70)?.bar).toBe(48);
    expect(getActiveExitSpot(cues, 100)?.bar).toBe(56);
    expect(getActiveExitSpot(cues, 115)).toBeNull();
    expect(getExitQualityAtTime(cues, 66)).toBe("good");
    expect(getExitQualityAtTime(cues, 82)).toBe("risky");
  });

  test("computes next beat 1 strictly within one bar ahead", () => {
    const grid = { bpm: 120, firstDownbeatSec: 0.5 }; // barSec = 2.0
    expect(getNextBeatOneSec(grid, 0.1)).toBeCloseTo(0.5, 4);
    expect(getNextBeatOneSec(grid, 0.5)).toBeCloseTo(2.5, 4);
    expect(getNextBeatOneSec(grid, 2.4)).toBeCloseTo(2.5, 4);
    expect(getNextBeatOneSec(grid, 2.51)).toBeCloseTo(4.5, 4);
  });
});
