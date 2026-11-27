import { memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  FolderOpen,
  ListPlus,
  Music,
  Play,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { evaluateBpmFit, type DeckId } from "@/core/dj-math";
import type { TrackItem } from "@/lib/audio-engine";
import { TRACK_DRAG_MIME, setTrackDragImage } from "@/lib/track-drag";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type SortMode = "title" | "artist" | "filename";

type ColumnId = "library" | "match";

interface LibraryPanelProps {
  tracks: TrackItem[];
  matchTracks: TrackItem[];
  /** BPM of the song on air; the BPM MATCH column is graded against it. */
  matchBpm: number | null;
  totalCount: number;
  query: string;
  sortMode: SortMode;
  savedFolderName: string | null;
  deckATrackId: string | null;
  deckBTrackId: string | null;
  liveDeck: DeckId | null;
  referenceBpm: number | null;
  playedIds: Set<string>;
  onQueryChange: (q: string) => void;
  onSortChange: (sort: SortMode) => void;
  onOpenFolder: () => void;
  onReconnectFolder: () => void;
  onLoadNext: (track: TrackItem) => void;
  onAddToQueue: (track: TrackItem) => void;
  onRequestMetadata: (track: TrackItem) => void;
  onPrioritizeBpm: (selected: TrackItem, lookahead: TrackItem[]) => void;
  onScrollActivity: () => void;
}

const ROW_HEIGHT = 56;

const SORT_LABELS: Record<SortMode, string> = {
  title: "Title (A–Z)",
  artist: "Artist (A–Z)",
  filename: "Filename",
};

export const LibraryPanel = memo(function LibraryPanel({
  tracks,
  matchTracks,
  matchBpm,
  totalCount,
  query,
  sortMode,
  savedFolderName,
  deckATrackId,
  deckBTrackId,
  liveDeck,
  referenceBpm,
  playedIds,
  onQueryChange,
  onSortChange,
  onOpenFolder,
  onReconnectFolder,
  onLoadNext,
  onAddToQueue,
  onRequestMetadata,
  onPrioritizeBpm,
  onScrollActivity,
}: LibraryPanelProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [activeColumn, setActiveColumn] = useState<ColumnId>("library");

  // Search shortcuts belong to the panel; row navigation belongs to the active column.
  useEffect(() => {
    if (totalCount === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setActiveColumn("library");
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === "Escape" && e.target === searchInputRef.current) {
        if (query) {
          onQueryChange("");
        } else {
          searchInputRef.current?.blur();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [totalCount, query, onQueryChange]);

  const columnProps = {
    query,
    sortMode,
    searchInputRef,
    deckATrackId,
    deckBTrackId,
    liveDeck,
    referenceBpm,
    playedIds,
    onQueryChange,
    onLoadNext,
    onAddToQueue,
    onRequestMetadata,
    onPrioritizeBpm,
    onScrollActivity,
  };

  return (
    <section
      aria-label="Song Library"
      className="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-card"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="flex shrink-0 items-center gap-1.5">
          <h2 className="text-xs font-bold tracking-wider text-dim">LIBRARY</h2>
          <span className="font-mono text-xs text-faint tabular-nums">
            {query ? `${tracks.length}/${totalCount}` : totalCount}
          </span>
        </div>

        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-2.5 size-3.5 text-faint" />
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(e) => {
              setActiveColumn("library");
              onQueryChange(e.target.value);
            }}
            placeholder={totalCount > 0 ? "Search…" : "Open folder…"}
            disabled={totalCount === 0}
            className="h-8 pl-8 pr-7 text-base md:text-xs"
            aria-label="Search library"
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              aria-label="Clear search"
              className="absolute right-1.5 rounded p-0.5 text-dim hover:bg-raised hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            totalCount > 0 && (
              <kbd className="pointer-events-none absolute right-2 hidden rounded border border-line bg-raised px-1 py-0.5 font-mono text-[9px] text-faint sm:inline-flex">
                Ctrl K
              </kbd>
            )
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="outline" className="text-xs">
                {SORT_LABELS[sortMode]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
                <DropdownMenuItem key={mode} onClick={() => onSortChange(mode)}>
                  {SORT_LABELS[mode]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {totalCount === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-brand-soft text-brand">
            <FolderOpen className="size-6" />
          </div>
          <div className="max-w-sm space-y-1">
            <h3 className="text-sm font-semibold text-fg">
              Load your flash drive music folder
            </h3>
            <p className="text-xs text-dim">
              Pick the folder containing your MP3, M4A, WAV, or FLAC songs. Everything
              stays 100% local on your machine—nothing is uploaded.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={onOpenFolder}>
              <FolderOpen className="size-4" />
              Open Music Folder
            </Button>
            {savedFolderName && (
              <Button variant="outline" onClick={onReconnectFolder}>
                <RotateCcw className="size-4" />
                Reconnect “{savedFolderName}”
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[3fr_2fr] md:grid-cols-2 md:grid-rows-1">
          <div className="flex min-h-0 flex-col">
            {tracks.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                <p className="text-sm font-medium text-fg">No songs match “{query}”</p>
                <Button size="sm" variant="outline" onClick={() => onQueryChange("")}>
                  Clear search
                </Button>
              </div>
            ) : (
              <TrackColumn
                {...columnProps}
                tracks={tracks}
                followsQuery
                active={activeColumn === "library"}
                onActivate={() => setActiveColumn("library")}
              />
            )}
          </div>

          <div className="flex min-h-0 flex-col border-t border-line md:border-t-0 md:border-l">
            <div className="flex items-center gap-1.5 px-3 pt-2">
              <h3 className="text-xs font-bold tracking-wider text-dim">BPM MATCH</h3>
              {matchBpm !== null && (
                <span className="font-mono text-xs text-faint tabular-nums">
                  {Math.round(matchBpm)} · {matchTracks.length}
                </span>
              )}
            </div>
            {matchTracks.length === 0 ? (
              <p className="px-3 py-2 text-xs text-faint">
                {matchBpm === null
                  ? "Load a track to see BPM matches."
                  : "No cached BPMs match yet. Matches appear as tracks are analysed."}
              </p>
            ) : (
              <TrackColumn
                {...columnProps}
                tracks={matchTracks}
                referenceBpm={matchBpm}
                gradeEveryRow
                followsQuery={false}
                active={activeColumn === "match"}
                onActivate={() => setActiveColumn("match")}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
});

interface TrackColumnProps {
  tracks: TrackItem[];
  /** Saves/restores browse position across a search and resets selection on new queries. */
  followsQuery: boolean;
  /** Colour every row's BPM by fit, not just the selected one. */
  gradeEveryRow?: boolean;
  /** Only the active column answers arrow / Enter / queue keys. */
  active: boolean;
  onActivate: () => void;
  query: string;
  sortMode: SortMode;
  searchInputRef: RefObject<HTMLInputElement | null>;
  deckATrackId: string | null;
  deckBTrackId: string | null;
  liveDeck: DeckId | null;
  referenceBpm: number | null;
  playedIds: Set<string>;
  onQueryChange: (q: string) => void;
  onLoadNext: (track: TrackItem) => void;
  onAddToQueue: (track: TrackItem) => void;
  onRequestMetadata: (track: TrackItem) => void;
  onPrioritizeBpm: (selected: TrackItem, lookahead: TrackItem[]) => void;
  onScrollActivity: () => void;
}

const TrackColumn = memo(function TrackColumn({
  tracks,
  followsQuery,
  gradeEveryRow = false,
  active,
  onActivate,
  query,
  sortMode,
  searchInputRef,
  deckATrackId,
  deckBTrackId,
  liveDeck,
  referenceBpm,
  playedIds,
  onQueryChange,
  onLoadNext,
  onAddToQueue,
  onRequestMetadata,
  onPrioritizeBpm,
  onScrollActivity,
}: TrackColumnProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const savedBrowseStateRef = useRef<{ scrollTop: number; selectedIndex: number } | null>(null);
  const prevQueryRef = useRef(query);

  // Track browse position while unfiltered; restore scroll & selection when search clears
  useEffect(() => {
    const prevQuery = prevQueryRef.current;
    prevQueryRef.current = query;
    if (!followsQuery) return;

    if (!prevQuery && query) {
      savedBrowseStateRef.current = {
        scrollTop: scrollRef.current?.scrollTop ?? 0,
        selectedIndex,
      };
      setSelectedIndex(0);
    } else if (prevQuery && !query && savedBrowseStateRef.current) {
      const { scrollTop, selectedIndex: prevIdx } = savedBrowseStateRef.current;
      savedBrowseStateRef.current = null;
      setSelectedIndex(prevIdx);
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollTop;
        }
      });
    }
  }, [followsQuery, query, selectedIndex]);

  const clampedIndex =
    tracks.length === 0 ? -1 : Math.min(Math.max(0, selectedIndex), tracks.length - 1);

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const activeTrack = clampedIndex >= 0 ? tracks[clampedIndex] : undefined;
  const activeFit =
    activeTrack && referenceBpm !== null
      ? evaluateBpmFit(referenceBpm, activeTrack.bpm)
      : null;

  const virtualItems = virtualizer.getVirtualItems();
  const firstVisibleIdx = virtualItems[0]?.index ?? -1;
  const lastVisibleIdx = virtualItems[virtualItems.length - 1]?.index ?? -1;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const activeTrackId = activeTrack?.id ?? null;

  // Debounce metadata/cover hydration (120ms) so fast scrolling doesn't fetch/parse rows you fly past
  useEffect(() => {
    if (firstVisibleIdx < 0 || lastVisibleIdx < firstVisibleIdx) return;
    const timer = window.setTimeout(() => {
      const list = tracksRef.current;
      for (let i = firstVisibleIdx; i <= lastVisibleIdx; i++) {
        const track = list[i];
        if (track && !track.metadataLoaded) {
          onRequestMetadata(track);
        }
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [firstVisibleIdx, lastVisibleIdx, tracks.length, query, sortMode, onRequestMetadata]);

  // Focus BPM calculation on selected song + alternating neighbors (+1, -1, +2, -2, ..., +5, -5)
  // Debounced (140ms) so holding ArrowDown skips intermediate rows and starts right where you land
  useEffect(() => {
    if (!active || clampedIndex < 0 || !activeTrackId) return;

    const timer = window.setTimeout(() => {
      const list = tracksRef.current;
      const selected = list[clampedIndex];
      if (!selected) return;

      const neighbors: TrackItem[] = [];
      for (let dist = 1; dist <= 5; dist++) {
        const after = list[clampedIndex + dist];
        if (after && (after.bpm === null || after.cues === null)) neighbors.push(after);
        const before = list[clampedIndex - dist];
        if (before && (before.bpm === null || before.cues === null)) neighbors.push(before);
      }

      if (selected.bpm === null || selected.cues === null || neighbors.length > 0) {
        onPrioritizeBpm(selected, neighbors);
      }
    }, 140);

    return () => window.clearTimeout(timer);
  }, [active, clampedIndex, activeTrackId, tracks.length, query, sortMode, onPrioritizeBpm]);

  const moveSelection = useCallback(
    (delta: number, isRapidRepeat = false) => {
      if (tracks.length === 0) return;
      if (isRapidRepeat) {
        onScrollActivity();
      }
      setSelectedIndex((prev) => {
        const base = prev < 0 ? 0 : Math.min(prev, tracks.length - 1);
        const next = Math.min(tracks.length - 1, Math.max(0, base + delta));
        // Keep 1 neighbor row visible ahead of the cursor (scrolloff = 1)
        const scrollTarget =
          delta > 0
            ? Math.min(tracks.length - 1, next + 1)
            : Math.max(0, next - 1);
        // Instant scroll during held-key repeat prevents smooth-scroll animation pileup
        virtualizer.scrollToIndex(scrollTarget, {
          align: "auto",
          behavior: isRapidRepeat ? "auto" : "smooth",
        });
        return next;
      });
    },
    [tracks.length, virtualizer, onScrollActivity],
  );

  // Leaving a search sends the user back to the full library column.
  const clearQueryOnPick = useCallback(() => {
    if (followsQuery && query) {
      onQueryChange("");
    }
  }, [followsQuery, query, onQueryChange]);

  useEffect(() => {
    if (!active || tracks.length === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const target = e.target as HTMLElement | null;
      const searchFocused = target === searchInputRef.current;
      const inInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1, e.repeat);
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1, e.repeat);
        return;
      }

      const selectedTrack = clampedIndex >= 0 ? tracks[clampedIndex] : undefined;
      if (!selectedTrack) return;

      if ((e.key === "Enter" || e.key === "/") && (searchFocused || !inInput)) {
        e.preventDefault();
        if (searchFocused) {
          searchInputRef.current?.blur();
        }
        clearQueryOnPick();
        if (e.key === "Enter" && !e.shiftKey) {
          onLoadNext(selectedTrack);
        } else {
          onAddToQueue(selectedTrack);
        }
        return;
      }

      if ((e.key === "q" || e.key === "Q") && !inInput) {
        e.preventDefault();
        clearQueryOnPick();
        onAddToQueue(selectedTrack);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    active,
    tracks,
    clampedIndex,
    searchInputRef,
    moveSelection,
    clearQueryOnPick,
    onAddToQueue,
    onLoadNext,
  ]);

  const selectRow = (index: number) => {
    onActivate();
    setSelectedIndex(index);
  };

  const pickRow = (index: number) => {
    searchInputRef.current?.blur();
    if (followsQuery && query) {
      onQueryChange("");
    } else {
      selectRow(index);
    }
  };

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 pb-[calc(var(--under-tabs,0px)+1rem)]"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {active && clampedIndex >= 0 && (
          <motion.div
            aria-hidden="true"
            initial={false}
            animate={{ y: clampedIndex * ROW_HEIGHT }}
            transition={{
              type: "spring",
              stiffness: 620,
              damping: 42,
              mass: 0.55,
            }}
            style={{ height: ROW_HEIGHT }}
            className="pointer-events-none absolute top-0 right-0 left-0 py-0.5"
          >
            <div
              className={cn(
                "relative h-full w-full overflow-hidden rounded-lg border transition-colors duration-200",
                activeFit?.status === "good" &&
                  "border-up-subtle bg-up-soft ring-1 ring-up-subtle",
                activeFit?.status === "ok" &&
                  "border-warn-subtle bg-warn-soft ring-1 ring-warn-subtle",
                activeFit?.status === "clash" &&
                  "border-down-subtle bg-down-soft ring-1 ring-down-subtle",
                (!activeFit || activeFit.status === "unknown") &&
                  "border-brand-line bg-brand-soft/65 ring-1 ring-brand-line",
              )}
            >
              <div
                className={cn(
                  "absolute top-1.5 bottom-1.5 left-0 w-1 rounded-r-full transition-colors duration-200",
                  activeFit?.status === "good" && "bg-up",
                  activeFit?.status === "ok" && "bg-warn",
                  activeFit?.status === "clash" && "bg-down",
                  (!activeFit || activeFit.status === "unknown") && "bg-brand",
                )}
              />
            </div>
          </motion.div>
        )}

        {virtualItems.map((vRow) => {
          const track = tracks[vRow.index];
          if (!track) return null;
          const onA = deckATrackId === track.id;
          const onB = deckBTrackId === track.id;
          const isPlayed = playedIds.has(track.id);
          const isLiveTrack = (onA && liveDeck === "A") || (onB && liveDeck === "B");
          const isSelected = active && vRow.index === clampedIndex;
          const selectedFit = isSelected
            ? activeFit
            : gradeEveryRow && referenceBpm !== null
              ? evaluateBpmFit(referenceBpm, track.bpm)
              : null;

          return (
            <div
              key={track.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${vRow.size}px`,
                transform: `translateY(${vRow.start}px)`,
              }}
              className="py-0.5"
            >
              <div
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "copy";
                  e.dataTransfer.setData(TRACK_DRAG_MIME, track.id);
                  e.dataTransfer.setData("text/plain", `${track.artist} - ${track.title}`);
                  setTrackDragImage(e, track.title);
                  selectRow(vRow.index);
                }}
                onClick={() => selectRow(vRow.index)}
                onPointerMove={(e) => {
                  if (
                    e.pointerType === "mouse" &&
                    (e.movementX !== 0 || e.movementY !== 0) &&
                    !isSelected
                  ) {
                    selectRow(vRow.index);
                  }
                }}
                className={cn(
                  "relative flex h-full cursor-grab items-center justify-between gap-2 rounded-lg border px-2.5 transition-colors duration-150 active:cursor-grabbing",
                  !isSelected && onA && "border-deck-a-line bg-deck-a-soft/50",
                  !isSelected && onB && "border-deck-b-line bg-deck-b-soft/50",
                  !isSelected && !onA && !onB && "border-transparent",
                  isSelected && "border-transparent",
                  isPlayed && !onA && !onB && !isSelected && "opacity-65",
                )}
              >
                <div className="relative flex min-w-0 flex-1 items-center gap-2.5">
                  <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">
                    {track.coverUrl ? (
                      <img
                        src={track.coverUrl}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    ) : (
                      <Music className="size-4 text-faint" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-fg">
                        {track.title}
                      </span>
                      {onA && (
                        <Badge
                          variant="outline"
                          className="shrink-0 border-deck-a-line bg-deck-a-soft px-1.5 py-0 text-[10px] text-deck-a"
                        >
                          {liveDeck === "A" ? "ON AIR A" : "DECK A"}
                        </Badge>
                      )}
                      {onB && (
                        <Badge
                          variant="outline"
                          className="shrink-0 border-deck-b-line bg-deck-b-soft px-1.5 py-0 text-[10px] text-deck-b"
                        >
                          {liveDeck === "B" ? "ON AIR B" : "DECK B"}
                        </Badge>
                      )}
                      {isPlayed && !isLiveTrack && (
                        <span
                          title="Played this session"
                          className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-up"
                        >
                          <CheckCircle2 className="size-3" />
                          Played
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-dim">
                      <span className="truncate">{track.artist}</span>
                      {track.bpm !== null ? (
                        <motion.span
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.2, ease: "easeOut" }}
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums transition-colors duration-200",
                            selectedFit?.status === "good" && "bg-up-soft text-up",
                            selectedFit?.status === "ok" && "bg-warn-soft text-warn",
                            selectedFit?.status === "clash" && "bg-down-soft text-down",
                            (!selectedFit || selectedFit.status === "unknown") &&
                              "bg-transparent px-0 font-normal text-faint",
                          )}
                        >
                          {selectedFit?.status === "good" && <Check className="size-2.5" />}
                          {selectedFit?.status === "clash" && (
                            <AlertTriangle className="size-2.5" />
                          )}
                          <span>{track.bpm} BPM</span>
                        </motion.span>
                      ) : (
                        <motion.span
                          initial={false}
                          animate={{ opacity: isSelected && referenceBpm !== null ? 0.7 : 0 }}
                          transition={{ duration: 0.18 }}
                          className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-faint"
                        >
                          <Activity className="size-2.5 animate-pulse" />
                          <span>BPM</span>
                        </motion.span>
                      )}
                    </div>
                  </div>
                </div>

                <div
                  className={cn(
                    "relative flex shrink-0 items-center gap-1.5 transition-opacity duration-150",
                    isSelected
                      ? "opacity-100"
                      : "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100",
                  )}
                >
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      pickRow(vRow.index);
                      onAddToQueue(track);
                    }}
                    title="Add to Up Next (/)"
                  >
                    <ListPlus className="size-3.5" />
                    <span className="hidden sm:inline">Queue</span>
                    <kbd className="hidden w-4 items-center justify-center rounded border border-line bg-raised font-mono text-[9px] text-dim sm:inline-flex">
                      /
                    </kbd>
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      pickRow(vRow.index);
                      onLoadNext(track);
                    }}
                    title="Load onto the next deck (Enter)"
                  >
                    <Play className="size-3" />
                    <span className="hidden sm:inline">Load</span>
                    <kbd className="hidden w-4 items-center justify-center rounded border border-line bg-bg/60 font-mono text-[9px] text-dim sm:inline-flex">
                      ↵
                    </kbd>
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
