import { memo, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Download,
  ChevronLeft,
  ChevronRight,
  Disc3,
  Lock,
  Play,
  Sparkles,
  Square,
  Unlock,
} from "lucide-react";
import { formatTime, type CueSpot, type DeckId } from "@/core/dj-math";
import type { DeckSnapshot } from "@/lib/audio-engine";
import { keyName, type KeyFit } from "@/core/key-detect";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WaveformCanvas } from "@/components/waveform-canvas";
import { TRACK_DRAG_MIME } from "@/lib/track-drag";

interface DeckCardProps {
  deckId: DeckId;
  deck: DeckSnapshot;
  isLive: boolean;
  /** Harmonic fit with the live deck; only set on the UP NEXT deck. */
  keyFit: KeyFit | null;
  audibility: number;
  isEndingSoon: boolean;
  loadFlashKey: number;
  cueSpots?: CueSpot[];
  flagSec?: number | null;
  canStepEntryPrev?: boolean;
  canStepEntryNext?: boolean;
  onStepEntry?: (delta: -1 | 1) => void;
  onPlay: () => void;
  onSoftStop: () => void;
  onSeek: (ratio: number) => void;
  onToggleLock: () => void;
  /** Accepts a library track dropped onto the deck; omitted when the deck is on air. */
  onDropTrack?: (trackId: string) => void;
}

export const DeckCard = memo(function DeckCard({
  deckId,
  deck,
  isLive,
  keyFit,
  audibility,
  isEndingSoon,
  loadFlashKey,
  cueSpots,
  flagSec,
  canStepEntryPrev = false,
  canStepEntryNext = false,
  onStepEntry,
  onPlay,
  onSoftStop,
  onSeek,
  onToggleLock,
  onDropTrack,
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

  const [dragOver, setDragOver] = useState(false);
  const acceptsDrag = (e: React.DragEvent) =>
    Boolean(onDropTrack) && e.dataTransfer.types.includes(TRACK_DRAG_MIME);

  const glowStrength = Math.min(1, Math.max(0, audibility));

  return (
    <div
      className="relative h-full"
      onDragEnter={(e) => {
        if (!acceptsDrag(e)) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!acceptsDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        setDragOver(false);
        const id = e.dataTransfer.getData(TRACK_DRAG_MIME);
        if (!onDropTrack || !id) return;
        e.preventDefault();
        onDropTrack(id);
      }}
    >
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
          "relative z-10 flex h-full flex-col gap-3 overflow-hidden rounded-xl border bg-card p-3.5 transition-colors",
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
              {deck.cues?.key && (
                <span
                  title={
                    keyFit === "clash"
                      ? `${keyName(deck.cues.key)}: key clashes with the live track, short blend`
                      : keyFit === "match"
                        ? `${keyName(deck.cues.key)}: key fits the live track`
                        : keyName(deck.cues.key)
                  }
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums",
                    keyFit === "match" && "bg-up-soft text-up",
                    keyFit === "clash" && "bg-warn-soft text-warn",
                    (keyFit === null || keyFit === "unknown") && "bg-raised text-fg",
                  )}
                >
                  {deck.cues.key.camelot}
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
        duration={deck.duration}
        spots={cueSpots}
        flagSec={flagSec}
        locked={deck.waveformLocked}
        hasTrack={Boolean(deck.track)}
        onSeek={onSeek}
      />

      {deck.track && (
        <div className="relative flex min-h-9 items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {!isLive && onStepEntry && (
              <Button
                size="icon-sm"
                variant="outline"
                disabled={!canStepEntryPrev}
                onClick={() => onStepEntry(-1)}
                aria-label="Previous entry point"
                title="Previous entry point (Left Arrow)"
              >
                <ChevronLeft className="size-4" />
              </Button>
            )}
            <Button
              size="sm"
              onClick={deck.isPlaying ? onSoftStop : onPlay}
              variant={deck.isPlaying ? "secondary" : "default"}
              className={cn(
                "min-w-24 font-semibold",
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
            {!isLive && onStepEntry && (
              <Button
                size="icon-sm"
                variant="outline"
                disabled={!canStepEntryNext}
                onClick={() => onStepEntry(1)}
                aria-label="Next entry point"
                title="Next entry point (Right Arrow)"
              >
                <ChevronRight className="size-4" />
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
      )}
      <AnimatePresence>
        {dragOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className={cn(
              "pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed text-sm font-semibold backdrop-blur-[2px]",
              isA
                ? "border-deck-a bg-deck-a-soft/70 text-deck-a"
                : "border-deck-b bg-deck-b-soft/70 text-deck-b",
            )}
          >
            <Download className="size-4" />
            Drop to load on Deck {deckId}
          </motion.div>
        )}
      </AnimatePresence>
      </motion.section>
    </div>
  );
});
