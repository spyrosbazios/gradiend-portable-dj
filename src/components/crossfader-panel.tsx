import { memo } from "react";
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
import { Slider } from "@/components/ui/slider";

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
        <div className="flex items-center justify-between text-xs font-bold">
          <span className="text-deck-a">A</span>
          <span className="text-deck-b">B</span>
        </div>
        <Slider
          aria-label="Crossfader"
          min={0}
          max={100}
          step={1}
          value={[Math.round(crossfade * 100)]}
          onValueChange={(vals) => onCrossfadeChange((vals[0] ?? 0) / 100)}
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
