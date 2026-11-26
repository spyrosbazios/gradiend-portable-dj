import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Check,
  GripVertical,
  ListMusic,
  Music,
  Play,
  Trash2,
  X,
} from "lucide-react";
import { evaluateBpmFit, type BpmFit, type DeckId } from "@/core/dj-math";
import type { TrackItem } from "@/lib/audio-engine";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface QueueEntry {
  uid: string;
  track: TrackItem;
}

interface QueuePanelProps {
  queue: QueueEntry[];
  liveBpm: number | null;
  stagedTrack: TrackItem | null;
  stagedBpm: number | null;
  stagedDeck: DeckId;
  autoPlayEnabled: boolean;
  onReorder: (nextQueue: QueueEntry[]) => void;
  onLoadAt: (index: number) => void;
  onRemoveAt: (index: number) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onClear: () => void;
}

function BpmFitPill({ bpm, fit }: { bpm: number | null; fit: BpmFit | null }) {
  if (bpm === null) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] text-faint">
        <Activity className="size-2.5 animate-pulse" />
        BPM…
      </span>
    );
  }

  if (!fit || fit.status === "unknown") {
    return (
      <span className="inline-flex shrink-0 items-center rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] text-dim tabular-nums">
        {bpm} BPM
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums",
        fit.status === "good" && "bg-up-soft text-up",
        fit.status === "ok" && "bg-warn-soft text-warn",
        fit.status === "clash" && "bg-down-soft text-down",
      )}
    >
      {fit.status === "good" && <Check className="size-2.5" />}
      {fit.status === "clash" && <AlertTriangle className="size-2.5" />}
      <span>{bpm} BPM</span>
    </span>
  );
}

interface QueueRowProps {
  entry: QueueEntry;
  index: number;
  prevBpm: number | null;
  onLoadAt: (index: number) => void;
  onRemoveAt: (index: number) => void;
}

function QueueRow({ entry, index, prevBpm, onLoadAt, onRemoveAt }: QueueRowProps) {
  const dragControls = useDragControls();
  const fit = prevBpm !== null ? evaluateBpmFit(prevBpm, entry.track.bpm) : null;

  return (
    <Reorder.Item
      value={entry}
      dragListener={false}
      dragControls={dragControls}
      layout="position"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{
        opacity: 0,
        scale: 0.96,
        transition: { duration: 0.14, ease: "easeOut" },
      }}
      whileDrag={{
        scale: 1.02,
        zIndex: 20,
      }}
      transition={{
        layout: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
        opacity: { duration: 0.15, ease: "easeOut" },
        scale: { duration: 0.15, ease: "easeOut" },
      }}
      className={cn(
        "group relative flex items-center gap-2 overflow-hidden rounded-lg border bg-bg/85 py-1.5 pr-1.5 pl-2 shadow-xs select-none",
        fit?.status === "clash"
          ? "border-down-subtle"
          : fit?.status === "good"
            ? "border-up-subtle/60"
            : "border-line",
      )}
    >
      <div
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-r-full",
          fit?.status === "good" && "bg-up",
          fit?.status === "ok" && "bg-warn",
          fit?.status === "clash" && "bg-down",
          (!fit || fit.status === "unknown") && "bg-line",
        )}
      />

      <button
        type="button"
        aria-label={`Drag to reorder ${entry.track.title}`}
        onPointerDown={(e) => {
          e.preventDefault();
          dragControls.start(e);
        }}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-faint hover:bg-raised hover:text-fg active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </button>

      <span className="w-3.5 shrink-0 text-center font-mono text-[10px] text-faint tabular-nums">
        {index + 1}
      </span>

      <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">
        {entry.track.coverUrl ? (
          <img
            src={entry.track.coverUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <Music className="size-3.5 text-faint" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-fg">
          {entry.track.title}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="truncate text-[11px] text-dim">{entry.track.artist}</span>
          <BpmFitPill bpm={entry.track.bpm} fit={fit} />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon-xs"
          variant="secondary"
          onClick={() => onLoadAt(index)}
          aria-label={`Load ${entry.track.title} onto next deck`}
          title="Load onto next deck"
        >
          <Play className="size-3" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => onRemoveAt(index)}
          aria-label={`Remove ${entry.track.title} from queue`}
          className="text-faint hover:text-down"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </Reorder.Item>
  );
}

export function QueuePanel({
  queue,
  liveBpm,
  stagedTrack,
  stagedBpm,
  stagedDeck,
  autoPlayEnabled,
  onReorder,
  onLoadAt,
  onRemoveAt,
  onClear,
}: QueuePanelProps) {
  const effectiveStagedBpm = stagedBpm ?? stagedTrack?.bpm ?? null;
  const stagedFit =
    liveBpm !== null && stagedTrack
      ? evaluateBpmFit(liveBpm, effectiveStagedBpm)
      : null;
  const stagedIsA = stagedDeck === "A";

  return (
    <section
      aria-label="Up Next Queue"
      className="flex min-h-0 flex-col rounded-xl border border-line bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-bold tracking-wider text-dim">UP NEXT</h2>
          <Badge variant="outline" className="border-line font-mono text-[10px] text-dim">
            {queue.length}
          </Badge>
        </div>

        {queue.length > 0 && (
          <Button size="xs" variant="ghost" onClick={onClear} className="text-dim hover:text-down">
            <Trash2 className="size-3.5" />
            Clear
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2.5 pb-[calc(var(--under-tabs,0px)+1rem)]">
        {stagedTrack && (
          <div
            className={cn(
              "mb-2.5 flex items-center gap-2.5 rounded-lg border p-2",
              stagedIsA
                ? "border-deck-a-line bg-deck-a-soft/60"
                : "border-deck-b-line bg-deck-b-soft/60",
            )}
          >
            <div
              className={cn(
                "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-raised",
                stagedIsA ? "border-deck-a-line" : "border-deck-b-line",
              )}
            >
              {stagedTrack.coverUrl ? (
                <img
                  src={stagedTrack.coverUrl}
                  alt=""
                  className="size-full object-cover"
                />
              ) : (
                <Music
                  className={cn("size-4", stagedIsA ? "text-deck-a" : "text-deck-b")}
                />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex items-center justify-between gap-2 text-[10px] font-bold tracking-wider">
                <span className={stagedIsA ? "text-deck-a" : "text-deck-b"}>
                  NEXT · DECK {stagedDeck}
                </span>
                <span className="text-dim">{autoPlayEnabled ? "AUTO" : "READY"}</span>
              </div>
              <div className="truncate text-xs font-semibold text-fg">
                {stagedTrack.title}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="truncate text-[11px] text-dim">{stagedTrack.artist}</span>
                <BpmFitPill bpm={effectiveStagedBpm} fit={stagedFit} />
              </div>
            </div>
          </div>
        )}

        <div className="relative">
          <Reorder.Group
            axis="y"
            values={queue}
            onReorder={onReorder}
            className="relative space-y-1.5"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {queue.map((entry, idx) => {
                const prevBpm =
                  idx === 0
                    ? (effectiveStagedBpm ?? liveBpm)
                    : (queue[idx - 1]?.track.bpm ?? null);
                return (
                  <QueueRow
                    key={entry.uid}
                    entry={entry}
                    index={idx}
                    prevBpm={prevBpm}
                    onLoadAt={onLoadAt}
                    onRemoveAt={onRemoveAt}
                  />
                );
              })}
            </AnimatePresence>
          </Reorder.Group>

          {queue.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.16, delay: 0.12, ease: "easeOut" }}
              className="flex flex-col items-center justify-center gap-2 py-8 text-center"
            >
              <div className="flex size-10 items-center justify-center rounded-xl bg-raised text-faint">
                <ListMusic className="size-5" />
              </div>
              <p className="text-xs font-medium text-dim">Queue is empty</p>
            </motion.div>
          )}
        </div>
      </div>
    </section>
  );
}
