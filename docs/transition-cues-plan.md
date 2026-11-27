<!-- reviewed: 2026-11-27 -->
# Transition cues — implementation plan

Wireframe: `docs/diagrams/transition-cues.png` (source `transition-cues.excalidraw`).

## Problem

There is no headphone cue output, so the DJ cannot pre-listen to the incoming track.
The app must therefore know, from analysis, where each track can be safely left and
entered, show that visually, and let the DJ decide.

## Behaviour (what the user sees)

**Live deck (ON AIR)**
- One dot under the waveform per phrase start (every 8 bars): good / ok / risky **exit**.
- An orange flag on the best exit = the suggested mix-out point. Auto-mix uses it.
- No new controls on the live deck.

**Next deck (UP NEXT)**
- Same dot row, rating each phrase start as an **entry**.
- An orange flag on the selected entry. On load it pre-selects the best entry.
- `‹` / `›` buttons under the waveform step the flag phrase to phrase; the keyboard
  `ArrowLeft` / `ArrowRight` trigger the same handlers (shortcut, not a second UI).
  A verdict line between the buttons names the rating and why ("Good entry · intro, no vocals").
- Wherever the flag stops **is** the choice. No confirm button.
- Arrow keys are ignored while focus is in an input (library search) — same guard as
  `library-panel.tsx`'s key handler.

**Crossfader panel**
- The existing transition pill in the header (`transitionLabel`) becomes the one home for
  the upcoming move: `In 0:42 · Bass swap` — countdown to the live deck's mix-out flag
  plus the planned technique. No other surface repeats it.
- The existing **Fade to X** button remains the only manual trigger. Pressed at any time,
  the mix starts on the **next beat 1** of the live deck (≤ one bar of wait).
- Button tint shows the quality of that next beat 1: `up` token when it falls in a good
  exit phrase, `warn` otherwise. It never refuses.
- Auto-mix fires at the mix-out flag unless the DJ already started a mix.
- If the playhead passes the flag (seek / late), the flag moves to the next good exit.

**Waveform tap** keeps seeking exactly as today; the lock button keeps blocking it.

## Data model (`src/core/dj-math.ts`)

```ts
export interface BeatGrid { bpm: number; firstDownbeatSec: number } // bar n = first + n*4*60/bpm
export type SpotQuality = "good" | "ok" | "risky";
export interface CueSpot { bar: number; sec: number; quality: SpotQuality; reason: string }
export interface TrackCues {
  version: 1;
  grid: BeatGrid | null;
  entries: CueSpot[];      // every phrase start, rated as an entry
  exits: CueSpot[];        // every phrase start, rated as an exit
  bestEntryBar: number;
  bestExitBar: number;
  confidence: "high" | "low";
}
```

- `TrackCues` replaces `cueInSec` / `cueOutSec` everywhere (`DeckSnapshot`, engine, console).
- `detectAudibleBounds` is **deleted**; its silence-trim logic becomes a step inside the
  new analysis (used to bound the search and as the no-grid fallback).
- The UP NEXT deck's selected entry lives in `DeckSnapshot` (`selectedEntryBar`), set by
  the engine on load to `bestEntryBar` and changed only by `‹ ›` / arrows.

## Analysis (pure functions in `dj-math.ts`, run in a worker)

1. **Envelopes** at ~100 Hz from the 22.05 kHz mono decode: total RMS, low band
   (< 150 Hz, one-pole low-pass), mid band (300 Hz–3 kHz, vocal proxy).
2. **BPM**: keep `estimateBpm`'s autocorrelation, run over the whole track (not only 28 s).
3. **Downbeat**: test the 4 beat offsets × fine shifts within one beat; pick the phase where
   low-band onsets align best on beat 1. Fit strength feeds `confidence`.
4. **Per-bar features**: energy, low, mid — normalised per track.
5. **Phrase starts**: every 8 bars from the grid origin; novelty (feature jump between
   bar n−1 and n) raises the score of real section changes.
6. **Rating**
   - Entry good: low energy / no mid-band before, energy rises after, inside first ~35%.
   - Exit good: energy or mid-band falls after, ≥ 16 bars before audible end.
   - `ok`: usable with a short fade. `risky`: mid-band (vocals) sustained across the
     boundary, or inside a high-energy drop.
   - `reason` is a short human string for the verdict line.
7. **No grid** (fit fails, live recordings): `grid = null`, a single entry and exit from the
   silence trim, `confidence = "low"`; the planner then picks echo-out + drop.

## Plumbing

- Rename `src/lib/bpm.worker.ts` → `src/lib/analysis.worker.ts`; it returns `{ bpm, cues }`.
  Update `bpm-scheduler.ts` (rename the module/class if its name no longer fits) and every caller in the same change.
- `audio-engine.ts` `loadTrack`: replace the inline `detectAudibleBounds` + BPM call with
  one worker request.
- Cache `TrackCues` alongside BPM in `idb-keyval` under `cacheKeyForTrack`; a `version`
  mismatch triggers re-analysis. Background scheduler computes cues in the same decode.
- `planMixTransition`: takes confidence and the chosen entry/exit qualities; `low` or a
  `risky` pair forces echo-out + drop on beat 1.

## Mixing engine

- `dj-console.tsx` auto-mix effect: trigger at `exits[bestExitBar].sec − lead`, not
  "N seconds before cueOut". Fade length in bars (8 or 16 from the plan) via outgoing BPM.
- Start alignment: seek the incoming deck to the selected entry's `sec`, start it at the
  outgoing deck's next bar line (compute from grid + `currentTime`, schedule with a timer
  corrected against `AudioContext.currentTime`). Manual Fade uses the same path.
- Measure actual start error in dev; if > ~40 ms, note it — do not add a drift corrector
  in this change.

## UI

- `waveform-canvas.tsx`: new props for `spots: CueSpot[]` and `flagSec`; draw the dot row
  and flag. Colours only via tokens: `--app-up`, `--app-warn`, `--app-down`, flag `--app-brand`.
  Grow the component height only by the dot row.
- `deck-card.tsx`: UP NEXT only — `‹ verdict ›` row. Live deck unchanged apart from the waveform.
- `crossfader-panel.tsx`: pill text = countdown + technique; Fade button tint by next-beat quality.
- Phone (stacked) layout: same components, nothing extra.

## Phases — one commit each, all gates green

| # | Ships | Verified by |
|---|---|---|
| 1 | Beat grid + downbeat in `dj-math` | `bun test`: synthetic click tracks at known BPM / offset |
| 2 | Per-bar features, phrase starts, entry/exit rating, no-grid fallback | `bun test`: synthetic intro/body/outro and vocal-band fixtures |
| 3 | Worker rename, cache, engine wiring; `detectAudibleBounds` + `cueInSec/cueOutSec` removed | typecheck, tests, load a real track in dev |
| 4 | Auto-mix on exit flag, next-beat-1 manual fade, planner uses quality | dev listen test |
| 5 | Waveform dots + flags, `‹ ›` + arrows, pill countdown, Fade tint | visual check desktop + 390 px |

## Out of scope

Pairwise key compatibility, drift correction during the blend, draggable flags,
a mix-out picker on the live deck.
