import { describe, expect, test } from "bun:test";
import {
  computeTransitionDsp,
  computeWaveformAndAutoGain,
  detectAudibleBounds,
  equalPowerGains,
  estimateBpm,
  evaluateBpmFit,
  formatTime,
  getIdleDeck,
  getLiveDeck,
  isAudioFile,
  isDeckFadedOut,
  parseFilenameMetadata,
  pickAutoNextTrack,
  planMixTransition,
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

  test("recognizes supported audio extensions", () => {
    expect(isAudioFile("track.mp3")).toBe(true);
    expect(isAudioFile("track.FLAC")).toBe(true);
    expect(isAudioFile("cover.jpg")).toBe(false);
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

describe("detectAudibleBounds", () => {
  test("skips silent intro and trims quiet outro tail", () => {
    const sr = 1000;
    const pcm = new Float32Array(sr * 40); // 40s track
    // 4s silent intro, audible from 4s to 34s, 6s silent outro
    for (let i = sr * 4; i < sr * 34; i++) {
      pcm[i] = Math.sin(i * 0.1) * 0.5;
    }
    const { cueInSec, cueOutSec } = detectAudibleBounds(pcm, sr, 2.5);
    expect(cueInSec).toBeCloseTo(4, 1);
    expect(cueOutSec).toBeCloseTo(34, 1);
  });

  test("applies minimum intro skip on immediate-start full tracks", () => {
    const sr = 1000;
    const pcm = new Float32Array(sr * 60).fill(0.4);
    const { cueInSec, cueOutSec } = detectAudibleBounds(pcm, sr, 2.5);
    expect(cueInSec).toBeCloseTo(2.5, 1);
    expect(cueOutSec).toBeCloseTo(60, 1);
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
  test("selects sync-bass-swap for close BPMs with tempo match within ±6%", () => {
    const plan = planMixTransition({
      mode: "smart",
      fromBpm: 124,
      toBpm: 120,
      baseDurationMs: 5000,
    });
    expect(plan.technique).toBe("sync-bass-swap");
    expect(plan.initialPlaybackRate).toBeCloseTo(124 / 120, 3);
    expect(plan.echoDelaySec).toBe(0);
  });

  test("selects filter-sweep for moderate BPM shift", () => {
    const plan = planMixTransition({
      mode: "smart",
      fromBpm: 120,
      toBpm: 132,
      baseDurationMs: 5000,
    });
    expect(plan.technique).toBe("filter-sweep");
    expect(plan.initialPlaybackRate).toBe(1);
    expect(plan.durationMs).toBe(5000);
  });

  test("selects BPM-synced echo-out for big BPM clashes", () => {
    const plan = planMixTransition({
      mode: "smart",
      fromBpm: 120,
      toBpm: 92,
      baseDurationMs: 5000,
    });
    expect(plan.technique).toBe("echo-out");
    expect(plan.durationMs).toBeLessThanOrEqual(2600);
    expect(plan.echoDelaySec).toBeCloseTo(0.375, 3); // dotted-eighth at 120 BPM
  });

  test("respects explicit bass-swap and classic overrides", () => {
    expect(
      planMixTransition({ mode: "bass-swap", fromBpm: 90, toBpm: 140, baseDurationMs: 5000 })
        .technique,
    ).toBe("bass-swap");
    expect(
      planMixTransition({ mode: "classic", fromBpm: 120, toBpm: 122, baseDurationMs: 5000 })
        .technique,
    ).toBe("classic");
  });

  test("bass-swap cuts incoming bass before midpoint and swaps cleanly after", () => {
    const start = computeTransitionDsp("sync-bass-swap", 0.2);
    const end = computeTransitionDsp("sync-bass-swap", 0.8);
    expect(start.outgoing.bassDb).toBeCloseTo(0, 1);
    expect(start.incoming.bassDb).toBeLessThan(-15);
    expect(end.outgoing.bassDb).toBeLessThan(-15);
    expect(end.incoming.bassDb).toBeCloseTo(0, 1);
  });

  test("echo-out feeds echo early then cuts send so delay decays cleanly", () => {
    const peak = computeTransitionDsp("echo-out", 0.35);
    const tail = computeTransitionDsp("echo-out", 0.8);
    expect(peak.outgoing.echoSend).toBeGreaterThan(0.4);
    expect(tail.outgoing.echoSend).toBeCloseTo(0, 4);
    expect(tail.incoming.gain).toBeCloseTo(1, 3);
    expect(tail.incoming.bassDb).toBe(0);
  });

  test("detectAudibleBounds snaps Beat-1 cue forward past quiet intro pads", () => {
    const sr = 1000;
    const pcm = new Float32Array(sr * 60);
    // 0..5s quiet pad (0.06), then loud beat hits at 5.0s (0.6)
    for (let i = 0; i < sr * 5; i++) pcm[i] = 0.06;
    for (let i = sr * 5; i < sr * 55; i++) pcm[i] = 0.6;
    const { cueInSec } = detectAudibleBounds(pcm, sr, 2.5);
    expect(cueInSec).toBeGreaterThanOrEqual(4.9);
    expect(cueInSec).toBeLessThanOrEqual(5.1);
  });
});
