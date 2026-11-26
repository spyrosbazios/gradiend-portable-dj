import { ArrowLeft, ArrowLeftRight, ArrowRight } from "lucide-react";
import type { DeckId } from "@/core/dj-math";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

interface CrossfaderPanelProps {
  crossfade: number;
  isAutoFading: boolean;
  fadeSeconds: number;
  nextDeck: DeckId;
  canAutoFade: boolean;
  onCrossfadeChange: (val: number) => void;
  onAutoFade: () => void;
  onFadeSecondsChange: (sec: number) => void;
}

const FADE_OPTIONS = [3, 5, 8] as const;

export function CrossfaderPanel({
  crossfade,
  isAutoFading,
  fadeSeconds,
  nextDeck,
  canAutoFade,
  onCrossfadeChange,
  onAutoFade,
  onFadeSecondsChange,
}: CrossfaderPanelProps) {
  return (
    <section
      aria-label="Crossfader Mixer"
      className="flex flex-col items-center justify-between gap-3 rounded-xl border border-line bg-card p-3.5"
    >
      <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-dim">
        <ArrowLeftRight className="size-3.5" />
        <span>CROSSFADER</span>
      </div>

      <div className="flex w-full flex-col gap-2">
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

        <div className="flex items-center justify-center gap-1">
          {FADE_OPTIONS.map((sec) => (
            <button
              key={sec}
              type="button"
              onClick={() => onFadeSecondsChange(sec)}
              className={
                fadeSeconds === sec
                  ? "rounded-md bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand"
                  : "rounded-md px-2 py-0.5 text-[11px] text-dim hover:bg-raised"
              }
            >
              {sec}s
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
