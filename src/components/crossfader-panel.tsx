import { ArrowLeft, ArrowLeftRight, ArrowRight, Sparkles } from "lucide-react";
import type { DeckId, MixMode } from "@/core/dj-math";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

interface CrossfaderPanelProps {
  crossfade: number;
  isAutoFading: boolean;
  fadeSeconds: number;
  mixMode: MixMode;
  transitionLabel: string | null;
  nextDeck: DeckId;
  canAutoFade: boolean;
  onCrossfadeChange: (val: number) => void;
  onAutoFade: () => void;
  onFadeSecondsChange: (sec: number) => void;
  onMixModeChange: (mode: MixMode) => void;
}

const FADE_OPTIONS = [3, 5, 8] as const;

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

export function CrossfaderPanel({
  crossfade,
  isAutoFading,
  fadeSeconds,
  mixMode,
  transitionLabel,
  nextDeck,
  canAutoFade,
  onCrossfadeChange,
  onAutoFade,
  onFadeSecondsChange,
  onMixModeChange,
}: CrossfaderPanelProps) {
  return (
    <section
      aria-label="Crossfader Mixer"
      className="flex flex-col items-center justify-between gap-2.5 rounded-xl border border-line bg-card p-3.5"
    >
      <div className="flex w-full items-center justify-between gap-1.5 text-[11px] font-bold tracking-wider text-dim">
        <span className="inline-flex items-center gap-1.5">
          <ArrowLeftRight className="size-3.5" />
          <span>CROSSFADER</span>
        </span>
        {transitionLabel && (
          <span
            title={isAutoFading ? "Active mix transition" : "Next mix transition"}
            className={cn(
              "inline-flex max-w-[104px] items-center gap-1 truncate rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-normal",
              isAutoFading
                ? "bg-brand-soft text-brand animate-pulse"
                : "bg-raised text-dim",
            )}
          >
            <Sparkles className="size-2.5 shrink-0" />
            <span className="truncate">{transitionLabel}</span>
          </span>
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
            nextDeck === "A"
              ? "bg-deck-a text-bg hover:bg-deck-a/90"
              : "bg-deck-b text-bg hover:bg-deck-b/90",
          )}
        >
          {nextDeck === "A" && (
            <ArrowLeft className={cn("size-4 shrink-0", isAutoFading && "animate-pulse")} />
          )}
          <span>
            {isAutoFading ? `Fading to ${nextDeck}…` : `Fade to ${nextDeck}`}
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

          <div className="flex items-center gap-0.5">
            {FADE_OPTIONS.map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() => onFadeSecondsChange(sec)}
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                  fadeSeconds === sec
                    ? "bg-brand-soft font-semibold text-brand"
                    : "text-dim hover:bg-raised",
                )}
              >
                {sec}s
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
