import { memo, useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowLeftRight, ArrowRight, Sparkles } from "lucide-react";
import {
  FADE_BAR_OPTIONS,
  type DeckId,
  type FadeBars,
  type MixMode,
  type SpotQuality,
} from "@/core/dj-math";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface CrossfaderPanelProps {
  crossfade: number;
  isAutoFading: boolean;
  fadeBars: FadeBars;
  mixMode: MixMode;
  transitionLabel: string | null;
  nextBeatQuality: SpotQuality | null;
  nextDeck: DeckId;
  canAutoFade: boolean;
  onCrossfadeChange: (val: number) => void;
  onAutoFade: () => void;
  onFadeBarsChange: (bars: FadeBars) => void;
  onMixModeChange: (mode: MixMode) => void;
}


const MIX_MODES: ReadonlyArray<{ id: MixMode; label: string; title: string }> = [
  {
    id: "smart",
    label: "Smart",
    title: "Auto-picks Tempo Sync + Bass Swap, Filter Sweep, or BPM Echo-Out based on BPM fit",
  },
  {
    id: "bass-swap",
    label: "Bass",
    title: "Swaps bass cleanly at the midpoint so kicks never clash",
  },
  {
    id: "classic",
    label: "Classic",
    title: "Pure equal-power volume crossfade",
  },
];

/** Values within this distance of a detent (A, centre, B) snap onto it while dragging. */
const SNAP = 0.035;
const DETENTS = [0, 0.5, 1] as const;

function snap(v: number): number {
  const clamped = Math.min(1, Math.max(0, v));
  for (const d of DETENTS) if (Math.abs(clamped - d) <= SNAP) return d;
  return clamped;
}

interface CrossfaderControlProps {
  value: number;
  isAutoFading: boolean;
  onChange: (val: number) => void;
}

/**
 * Touch-first crossfader. Grabbing the cap drags it relative to the finger (no jump);
 * tapping the track glides the cap there; double-tap centres it. Snaps to A / centre / B.
 */
function CrossfaderControl({ value, isAutoFading, onChange }: CrossfaderControlProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);
  const lastTap = useRef(0);
  const [dragging, setDragging] = useState(false);

  const ratioAt = useCallback((clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return (clientX - rect.left) / rect.width;
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      onChange(0.5);
      return;
    }
    lastTap.current = now;
    const pointerRatio = ratioAt(e.clientX);
    const onCap = (e.target as HTMLElement).closest("[data-fader-cap]") !== null;
    // Grabbing the cap keeps its offset under the finger; a track tap moves the cap to the finger.
    const offset = onCap ? value - pointerRatio : 0;
    if (!onCap) onChange(snap(pointerRatio));
    drag.current = { pointerId: e.pointerId, offset };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    onChange(snap(ratioAt(e.clientX) + d.offset));
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const next =
      e.key === "ArrowLeft" || e.key === "ArrowDown"
        ? value - step
        : e.key === "ArrowRight" || e.key === "ArrowUp"
          ? value + step
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? 1
              : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(Math.min(1, Math.max(0, next)));
  };

  const pct = value * 100;

  return (
    <div className="flex w-full flex-col gap-1">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Crossfader"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={
          value === 0.5 ? "Centre" : value < 0.5 ? `Deck A ${Math.round((1 - value) * 100)}%` : `Deck B ${Math.round(pct)}%`
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className="relative h-12 w-full cursor-pointer touch-none rounded-lg select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        <div className="absolute inset-x-3 top-1/2 h-2 -translate-y-1/2 rounded-full bg-raised">
          <div
            className="absolute inset-y-0 left-0 rounded-l-full bg-deck-a/70"
            style={{ width: `${(1 - value) * 50}%` }}
          />
          <div
            className="absolute inset-y-0 right-0 rounded-r-full bg-deck-b/70"
            style={{ width: `${value * 50}%` }}
          />
          <div aria-hidden="true" className="absolute top-1/2 left-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-faint" />
        </div>
        <span className="pointer-events-none absolute top-1/2 left-0 -translate-y-1/2 text-xs font-bold text-deck-a">A</span>
        <span className="pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 text-xs font-bold text-deck-b">B</span>
        <div className="pointer-events-none absolute inset-x-3 inset-y-0">
          <motion.div
            data-fader-cap
            initial={false}
            animate={{ left: `${pct}%`, scale: dragging ? 1.12 : 1 }}
            transition={
              dragging
                ? { left: { duration: 0 }, scale: { type: "spring", stiffness: 600, damping: 30 } }
                : isAutoFading
                  ? { left: { duration: 0 }, scale: { duration: 0.15 } }
                  : { type: "spring", stiffness: 520, damping: 38 }
            }
            className={cn(
              "pointer-events-auto absolute top-1/2 flex h-10 w-7 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center gap-0.5 rounded-md border bg-card shadow-md",
              dragging ? "cursor-grabbing border-brand" : "border-line",
            )}
          >
            <span className="h-5 w-px bg-dim" />
            <span className="h-5 w-0.5 bg-fg" />
            <span className="h-5 w-px bg-dim" />
          </motion.div>
        </div>
      </div>
    </div>
  );
}

export const CrossfaderPanel = memo(function CrossfaderPanel({
  crossfade,
  isAutoFading,
  fadeBars,
  mixMode,
  transitionLabel,
  nextBeatQuality,
  nextDeck,
  canAutoFade,
  onCrossfadeChange,
  onAutoFade,
  onFadeBarsChange,
  onMixModeChange,
}: CrossfaderPanelProps) {
  const isGoodNextBeat = nextBeatQuality === "good";
  const hasLiveQuality = nextBeatQuality !== null;

  return (
    <section
      aria-label="Crossfader Mixer"
      className="flex flex-col items-center justify-between gap-2.5 rounded-xl border border-line bg-card p-3.5"
    >
      <div className="flex w-full flex-col gap-1.5">
        <div className="flex w-full items-center justify-between gap-1.5 text-[11px] font-bold tracking-wider text-dim">
          <span className="inline-flex items-center gap-1.5">
            <ArrowLeftRight className="size-3.5" />
            <span>CROSSFADER</span>
          </span>
        </div>

        {transitionLabel && (
          <div
            title={isAutoFading ? "Active mix transition" : "Upcoming mix move"}
            className={cn(
              "inline-flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold tabular-nums",
              isAutoFading
                ? "border-brand-line bg-brand-soft text-brand animate-pulse"
                : "border-brand-line bg-brand-soft text-brand",
            )}
          >
            <Sparkles className="size-3 shrink-0" />
            <span className="truncate">{transitionLabel}</span>
          </div>
        )}
      </div>

      <div className="flex w-full flex-col gap-1.5">
        <CrossfaderControl
          value={crossfade}
          isAutoFading={isAutoFading}
          onChange={onCrossfadeChange}
        />
      </div>

      <div className="flex w-full flex-col gap-2">
        <Button
          size="sm"
          disabled={!canAutoFade || isAutoFading}
          onClick={onAutoFade}
          className={cn(
            "w-full gap-1.5 font-semibold",
            hasLiveQuality
              ? isGoodNextBeat
                ? "bg-up text-bg hover:bg-up/90"
                : "bg-warn text-bg hover:bg-warn/90"
              : nextDeck === "A"
                ? "bg-deck-a text-bg hover:bg-deck-a/90"
                : "bg-deck-b text-bg hover:bg-deck-b/90",
          )}
        >
          {nextDeck === "A" && (
            <ArrowLeft className={cn("size-4 shrink-0", isAutoFading && "animate-pulse")} />
          )}
          <span className="truncate">
            {isAutoFading
              ? `Fading to ${nextDeck}…`
              : isGoodNextBeat
                ? `Fade to ${nextDeck} · good now`
                : `Fade to ${nextDeck}`}
          </span>
          {!isAutoFading && (
            <kbd className="hidden rounded bg-bg/20 px-1 py-0.5 font-mono text-[9px] font-bold tracking-tight uppercase sm:inline-flex">
              Shift
            </kbd>
          )}
          {nextDeck === "B" && (
            <ArrowRight className={cn("size-4 shrink-0", isAutoFading && "animate-pulse")} />
          )}
        </Button>

        <div className="flex items-center justify-between gap-1">
          <div
            role="group"
            aria-label="Mix style"
            className="inline-flex items-center rounded-md border border-line bg-bg/60 p-0.5"
          >
            {MIX_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.title}
                aria-pressed={mixMode === m.id}
                onClick={() => onMixModeChange(m.id)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors",
                  mixMode === m.id
                    ? "bg-brand-soft text-brand"
                    : "text-dim hover:text-fg",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div role="group" aria-label="Mix length in bars" className="flex items-center gap-0.5">
            {FADE_BAR_OPTIONS.map((bars) => (
              <button
                key={bars}
                type="button"
                aria-pressed={fadeBars === bars}
                title={`Mix over ${bars} bars`}
                onClick={() => onFadeBarsChange(bars)}
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                  fadeBars === bars
                    ? "bg-brand-soft font-semibold text-brand"
                    : "text-dim hover:bg-raised",
                )}
              >
                {bars}
              </button>
            ))}
            <span className="pl-0.5 text-[10px] text-faint">bars</span>
          </div>
        </div>
      </div>
    </section>
  );
});
