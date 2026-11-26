import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Disc3, Lock, Play, Sparkles, Square, Unlock } from "lucide-react";
import { formatTime, type DeckId } from "@/core/dj-math";
import type { DeckSnapshot } from "@/lib/audio-engine";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WaveformCanvas } from "@/components/waveform-canvas";

interface DeckCardProps {
  deckId: DeckId;
  deck: DeckSnapshot;
  isLive: boolean;
  audibility: number;
  isEndingSoon: boolean;
  playBlockedByFader: boolean;
  loadFlashKey: number;
  onPlay: () => void;
  onSoftStop: () => void;
  onSeek: (ratio: number) => void;
  onToggleLock: () => void;
}

export function DeckCard({
  deckId,
  deck,
  isLive,
  audibility,
  isEndingSoon,
  playBlockedByFader,
  loadFlashKey,
  onPlay,
  onSoftStop,
  onSeek,
  onToggleLock,
}: DeckCardProps) {
  const isA = deckId === "A";
  const remaining = Math.max(0, deck.duration - deck.currentTime);
  const progress = deck.duration > 0 ? deck.currentTime / deck.duration : 0;

  const [showLoadedBanner, setShowLoadedBanner] = useState(false);

  useEffect(() => {
    if (loadFlashKey === 0) return;
    setShowLoadedBanner(true);
    const timer = window.setTimeout(() => setShowLoadedBanner(false), 700);
    return () => window.clearTimeout(timer);
  }, [loadFlashKey]);

  const glowStrength = Math.min(1, Math.max(0, audibility));

  return (
    <div className="relative">
      <motion.div
        aria-hidden="true"
        initial={false}
        animate={{
          opacity: glowStrength * 0.36,
          scale: 0.97 + glowStrength * 0.035,
        }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className={cn(
          "pointer-events-none absolute -inset-1.5 z-0 rounded-2xl blur-xl",
          isA ? "bg-deck-a" : "bg-deck-b",
        )}
      />

      <motion.section
        aria-label={`Deck ${deckId}`}
        animate={showLoadedBanner ? { scale: [1, 1.012, 1] } : { scale: 1 }}
        transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
        className={cn(
          "relative z-10 flex flex-col gap-3 overflow-hidden rounded-xl border bg-card p-3.5 transition-colors",
          isLive && isA && "border-deck-a ring-1 ring-deck-a/35",
          isLive && !isA && "border-deck-b ring-1 ring-deck-b/35",
          !isLive && "border-line",
          isEndingSoon && "border-warn ring-1 ring-warn/50",
        )}
      >
      <AnimatePresence>
        {showLoadedBanner && (
          <motion.div
            key={`flash-${loadFlashKey}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.65, times: [0, 0.2, 1], ease: "easeOut" }}
            className={cn(
              "pointer-events-none absolute inset-0 rounded-xl border-2",
              isA
                ? "border-deck-a bg-deck-a-soft/60"
                : "border-deck-b bg-deck-b-soft/60",
            )}
          />
        )}
      </AnimatePresence>

      <div className="relative flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-xs font-bold tracking-wider",
              isA ? "text-deck-a" : "text-deck-b",
            )}
          >
            DECK {deckId}
          </span>
          {isLive ? (
            <Badge
              variant="outline"
              className={cn(
                "border-transparent text-[10px] font-bold tracking-wide",
                isA
                  ? "bg-deck-a-soft text-deck-a"
                  : "bg-deck-b-soft text-deck-b",
              )}
            >
              ON AIR
            </Badge>
          ) : (
            <Badge variant="outline" className="border-line text-[10px] text-dim">
              {deck.track ? "UP NEXT" : "EMPTY"}
            </Badge>
          )}

          <AnimatePresence>
            {showLoadedBanner && (
              <motion.span
                key={`pill-${loadFlashKey}`}
                initial={{ opacity: 0, scale: 0.85, x: -6 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold",
                  isA ? "bg-deck-a text-bg" : "bg-deck-b text-bg",
                )}
              >
                <Sparkles className="size-2.5" />
                LOADED
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
          {deck.track ? (
            <>
              <span className="text-dim">{formatTime(deck.currentTime)}</span>
              <span className="text-faint">/</span>
              <span className={cn(isEndingSoon ? "font-bold text-warn" : "text-dim")}>
                -{formatTime(remaining)}
              </span>
            </>
          ) : (
            <span className="text-faint">00:00 / 00:00</span>
          )}
        </div>
      </div>

      <div className="relative flex items-center gap-3">
        <motion.div
          key={`cover-${deck.track?.id ?? "empty"}-${loadFlashKey}`}
          initial={loadFlashKey > 0 ? { scale: 0.82, opacity: 0.7 } : false}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 460, damping: 26 }}
          className={cn(
            "relative flex size-13 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 shadow-sm",
            isA
              ? "border-deck-a-line bg-deck-a-soft"
              : "border-deck-b-line bg-deck-b-soft",
          )}
        >
          <div
            className={cn(
              "flex size-full items-center justify-center rounded-full",
              deck.track && "animate-spin",
            )}
            style={
              deck.track
                ? {
                    animationDuration: "3.6s",
                    animationPlayState: deck.isPlaying ? "running" : "paused",
                  }
                : undefined
            }
          >
            {deck.track?.coverUrl ? (
              <img
                src={deck.track.coverUrl}
                alt={deck.track.title}
                className="size-full rounded-full object-cover"
              />
            ) : (
              <Disc3 className={cn("size-7", isA ? "text-deck-a" : "text-deck-b")} />
            )}
          </div>
          {deck.track && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute size-3 rounded-full border border-line bg-card shadow-inner"
            />
          )}
        </motion.div>

        <motion.div
          key={`meta-${deck.track?.id ?? "empty"}-${loadFlashKey}`}
          initial={loadFlashKey > 0 ? { opacity: 0.4, x: 8 } : false}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
          className="min-w-0 flex-1"
        >
          <div className="truncate text-sm font-semibold text-fg">
            {deck.track ? deck.track.title : "Empty Deck"}
          </div>
          {deck.track && (
            <div className="flex items-center gap-1.5 truncate text-xs text-dim">
              <span className="truncate">{deck.track.artist}</span>
              {deck.bpm !== null && (
                <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] font-semibold text-fg tabular-nums">
                  {deck.bpm} BPM
                </span>
              )}
            </div>
          )}
        </motion.div>
      </div>

      <WaveformCanvas
        deckId={deckId}
        peaks={deck.peaks}
        loading={deck.peaksLoading}
        progress={progress}
        locked={deck.waveformLocked}
        hasTrack={Boolean(deck.track)}
        onSeek={onSeek}
      />

      <div className="relative flex min-h-8 items-center justify-between gap-2">
        <div>
          {deck.track && (deck.isPlaying || !playBlockedByFader) && (
            <Button
              size="sm"
              onClick={deck.isPlaying ? onSoftStop : onPlay}
              variant={deck.isPlaying ? "secondary" : "default"}
              className={cn(
                "min-w-28 font-semibold",
                !deck.isPlaying && isA && "bg-deck-a text-bg hover:bg-deck-a/90",
                !deck.isPlaying && !isA && "bg-deck-b text-bg hover:bg-deck-b/90",
              )}
            >
              {deck.isPlaying ? (
                <>
                  <Square className="size-3.5 fill-current" />
                  Stop
                </>
              ) : (
                <>
                  <Play className="size-3.5 fill-current" />
                  Play
                </>
              )}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {isEndingSoon && (
            <span className="text-xs font-semibold text-warn">Ending</span>
          )}
          {deck.track && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={onToggleLock}
                  aria-label={
                    deck.waveformLocked
                      ? "Unlock waveform scrubbing"
                      : "Lock waveform scrubbing"
                  }
                >
                  {deck.waveformLocked ? (
                    <Lock className="size-4 text-warn" />
                  ) : (
                    <Unlock className="size-4 text-dim" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {deck.waveformLocked
                  ? "Waveform locked to prevent accidental skips (click to unlock)"
                  : "Click waveform to cue start position"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      </motion.section>
    </div>
  );
}
