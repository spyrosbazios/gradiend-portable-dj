import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Disc3,
  Download,
  FolderOpen,
  ListMusic,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  Music,
  Sun,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import {
  equalPowerGains,
  getIdleDeck,
  getLiveDeck,
  isDeckFadedOut,
  pickAutoNextTrack,
  planMixTransition,
  type DeckId,
  type MixMode,
} from "@/core/dj-math";
import { THEMES, type ThemeName } from "@/core/theme";
import { djEngine, type TrackItem } from "@/lib/audio-engine";
import { bpmScheduler } from "@/lib/bpm-scheduler";
import {
  filesToTrackItems,
  getSavedFolderName,
  hydrateCachedLibrary,
  hydrateTrackMetadata,
  pickDirectoryTracks,
  reconnectSavedFolder,
  supportsDirectoryPicker,
} from "@/lib/library-loader";
import { searchTracks } from "@/lib/search";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import { useMedia } from "@/hooks/use-media";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeckCard } from "@/components/deck-card";
import { CrossfaderPanel } from "@/components/crossfader-panel";
import { LibraryPanel, type SortMode } from "@/components/library-panel";
import { QueuePanel, type QueueEntry } from "@/components/queue-panel";
import { SoundboardBar } from "@/components/soundboard-bar";
import {
  loadSoundPads,
  saveSoundPads,
  soundboardPlayer,
  type SoundPad,
} from "@/lib/soundboard";

export type MobileTab = "decks" | "library" | "queue";

interface DjConsoleProps {
  query: string;
  sortMode: SortMode;
  mobileTab: MobileTab;
  onQueryChange: (q: string) => void;
  onSortChange: (sort: SortMode) => void;
  onMobileTabChange: (tab: MobileTab) => void;
}

const AUTO_FADE_LEAD_BUFFER_SEC = 2.5;
const MIX_MODE_STORAGE_KEY = "portable-dj:mix-mode";

function readInitialMixMode(): MixMode {
  try {
    const raw = localStorage.getItem(MIX_MODE_STORAGE_KEY);
    if (raw === "smart" || raw === "bass-swap" || raw === "classic") return raw;
  } catch {
    // ignore storage errors
  }
  return "smart";
}

export function DjConsole({
  query,
  sortMode,
  mobileTab,
  onQueryChange,
  onSortChange,
  onMobileTabChange,
}: DjConsoleProps) {
  const isDesktop = useMedia("(min-width: 768px)");
  const { theme, setTheme } = useTheme();
  const { canInstall, install } = usePwaInstall();

  const [tracks, setTracks] = useState<TrackItem[]>([]);
  const [savedFolderName, setSavedFolderName] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(true);
  const [fadeSeconds, setFadeSeconds] = useState(5);
  const [mixMode, setMixMode] = useState<MixMode>(readInitialMixMode);

  useEffect(() => {
    djEngine.setMixMode(mixMode);
    try {
      localStorage.setItem(MIX_MODE_STORAGE_KEY, mixMode);
    } catch {
      // ignore storage errors
    }
  }, [mixMode]);
  const [playedIds, setPlayedIds] = useState<Set<string>>(() => new Set());
  const [loadFlashA, setLoadFlashA] = useState(0);
  const [loadFlashB, setLoadFlashB] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [soundPads, setSoundPads] = useState<SoundPad[]>([]);
  const [activePadIds, setActivePadIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    void loadSoundPads().then(setSoundPads);
  }, []);

  const triggerSoundPad = useCallback((pad: SoundPad) => {
    setActivePadIds((prev) => {
      const next = new Set(prev);
      next.add(pad.id);
      return next;
    });
    soundboardPlayer.play(pad, djEngine.getMasterVolume(), () => {
      setActivePadIds((prev) => {
        if (!prev.has(pad.id)) return prev;
        const next = new Set(prev);
        next.delete(pad.id);
        return next;
      });
    });
  }, []);

  const handleAddSoundPad = useCallback((pad: SoundPad) => {
    setSoundPads((prev) => {
      const next = [...prev, pad];
      void saveSoundPads(next);
      return next;
    });
  }, []);

  const handleRemoveSoundPad = useCallback((padId: string) => {
    soundboardPlayer.dispose(padId);
    setSoundPads((prev) => {
      const removed = prev.find((p) => p.id === padId);
      const next = prev.filter((p) => p.id !== padId);
      void saveSoundPads(next);
      if (removed) {
        toast(`Removed “${removed.label}”`, {
          action: {
            label: "Undo",
            onClick: () => {
              setSoundPads((cur) => {
                const restored = [...cur, removed];
                void saveSoundPads(restored);
                return restored;
              });
            },
          },
        });
      }
      return next;
    });
  }, []);

  // Number keys 1-9 trigger soundboard pads (ignored while typing or in a dialog)
  useEffect(() => {
    if (soundPads.length === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (document.querySelector('[role="dialog"]')) return;
      const target = e.target as HTMLElement | null;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      if (inEditable) return;

      const digit = Number.parseInt(e.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const pad = soundPads[digit - 1];
      if (!pad) return;
      e.preventDefault();
      triggerSoundPad(pad);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [soundPads, triggerSoundPad]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen?.();
    }
  }, []);

  const flashDeck = useCallback((id: DeckId) => {
    if (id === "A") {
      setLoadFlashA((n) => n + 1);
    } else {
      setLoadFlashB((n) => n + 1);
    }
  }, []);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hydratingRef = useRef<Set<string>>(new Set());
  const metaQueueRef = useRef<TrackItem[]>([]);
  const metaActiveCountRef = useRef(0);
  const autoFadeTriggeredForRef = useRef<string | null>(null);
  const autoPickTriggeredForRef = useRef<string | null>(null);
  const queueSeqRef = useRef(0);
  const queueRef = useRef<QueueEntry[]>(queue);
  queueRef.current = queue;

  // Subscribe to Web Audio engine snapshots
  const engineVersion = useSyncExternalStore(
    (cb) => djEngine.subscribe(cb),
    () =>
      `${djEngine.getDeck("A").currentTime.toFixed(1)}:${djEngine.getDeck("A").isPlaying}:${djEngine.getDeck("A").track?.id ?? ""}:${djEngine.getDeck("A").peaks.length}:${djEngine.getDeck("A").bpm ?? ""}:${djEngine.getDeck("A").waveformLocked}|${djEngine.getDeck("B").currentTime.toFixed(1)}:${djEngine.getDeck("B").isPlaying}:${djEngine.getDeck("B").track?.id ?? ""}:${djEngine.getDeck("B").peaks.length}:${djEngine.getDeck("B").bpm ?? ""}:${djEngine.getDeck("B").waveformLocked}|${djEngine.getCrossfade().toFixed(3)}:${djEngine.getIsAutoFading()}:${djEngine.getActiveTransitionLabel() ?? ""}:${djEngine.getMasterVolume().toFixed(2)}`,
  );
  void engineVersion;

  const deckA = djEngine.getDeck("A");
  const deckB = djEngine.getDeck("B");
  const crossfade = djEngine.getCrossfade();
  const masterVolume = djEngine.getMasterVolume();
  const isAutoFading = djEngine.getIsAutoFading();
  const activeTransitionLabel = djEngine.getActiveTransitionLabel();

  const liveDeck = getLiveDeck(crossfade, deckA.isPlaying, deckB.isPlaying);
  const idleDeck = getIdleDeck(crossfade, deckA.isPlaying, deckB.isPlaying);
  const idleSnapshot = idleDeck === "A" ? deckA : deckB;
  const liveSnapshot = liveDeck === "A" ? deckA : liveDeck === "B" ? deckB : null;

  const isAEndingSoon =
    deckA.isPlaying && deckA.duration > 30 && deckA.duration - deckA.currentTime <= 30;
  const isBEndingSoon =
    deckB.isPlaying && deckB.duration > 30 && deckB.duration - deckB.currentTime <= 30;

  const anyDeckPlaying = deckA.isPlaying || deckB.isPlaying;
  const playBlockedA = anyDeckPlaying && isDeckFadedOut("A", crossfade);
  const playBlockedB = anyDeckPlaying && isDeckFadedOut("B", crossfade);
  const { gainA, gainB } = equalPowerGains(crossfade);
  const audibilityA = deckA.isPlaying ? gainA : 0;
  const audibilityB = deckB.isPlaying ? gainB : 0;

  // Reference BPM for library arrow-navigation color-coding:
  // compares against the tail of the queue if non-empty, else the staged UP NEXT deck, else the live deck
  const lastQueuedBpm = queue.length > 0 ? (queue[queue.length - 1]?.track.bpm ?? null) : null;
  const referenceBpm =
    lastQueuedBpm ?? idleSnapshot.bpm ?? liveSnapshot?.bpm ?? deckA.bpm ?? deckB.bpm ?? null;

  const upcomingTransitionPlan = useMemo(() => {
    if (!idleSnapshot.track) return null;
    if (!liveSnapshot?.isPlaying) {
      return planMixTransition({
        mode: "classic",
        fromBpm: null,
        toBpm: idleSnapshot.bpm ?? idleSnapshot.track.bpm,
        baseDurationMs: fadeSeconds * 1000,
      });
    }
    return planMixTransition({
      mode: mixMode,
      fromBpm: liveSnapshot.bpm ?? liveSnapshot.track?.bpm ?? null,
      toBpm: idleSnapshot.bpm ?? idleSnapshot.track.bpm,
      baseDurationMs: fadeSeconds * 1000,
    });
  }, [
    idleSnapshot.track,
    idleSnapshot.bpm,
    liveSnapshot?.isPlaying,
    liveSnapshot?.bpm,
    liveSnapshot?.track?.bpm,
    mixMode,
    fadeSeconds,
  ]);

  const transitionBadgeLabel = isAutoFading
    ? activeTransitionLabel
    : (upcomingTransitionPlan?.label ?? null);

  const handlePlayDeck = useCallback(
    (id: DeckId) => {
      const otherPlaying = id === "A" ? deckB.isPlaying : deckA.isPlaying;
      const fadedOut = isDeckFadedOut(id, crossfade);

      if (fadedOut) {
        if (otherPlaying) {
          toast.info(`Crossfader is on Deck ${id === "A" ? "B" : "A"} — tap Shift to fade to Deck ${id}.`);
          return;
        }
        // Nothing is playing: automatically route crossfader to the deck the user wants to start
        djEngine.setCrossfade(id === "A" ? 0 : 1, false);
      }

      void djEngine.play(id);
    },
    [crossfade, deckA.isPlaying, deckB.isPlaying],
  );

  useEffect(() => {
    void getSavedFolderName().then(setSavedFolderName);
  }, []);

  // Wire Web Worker background BPM scheduler results into tracks + queue
  useEffect(() => {
    bpmScheduler.setListener((trackId, bpm) => {
      setTracks((prev) =>
        prev.map((item) => (item.id === trackId ? { ...item, bpm } : item)),
      );
      setQueue((prev) =>
        prev.map((entry) =>
          entry.track.id === trackId
            ? { ...entry, track: { ...entry.track, bpm } }
            : entry,
        ),
      );
    });
    return () => {
      bpmScheduler.setListener(null);
    };
  }, []);

  // Anti-embarrassment: warn before closing tab while music is playing
  useEffect(() => {
    const anyPlaying = deckA.isPlaying || deckB.isPlaying;
    if (!anyPlaying) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [deckA.isPlaying, deckB.isPlaying]);

  // Keep screen awake while playing
  useEffect(() => {
    const anyPlaying = deckA.isPlaying || deckB.isPlaying;
    if (!anyPlaying || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    const requestLock = async () => {
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // silent if refused
      }
    };
    void requestLock();
    const onVisible = () => {
      if (document.visibilityState === "visible") void requestLock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release();
    };
  }, [deckA.isPlaying, deckB.isPlaying]);

  // Left/Right arrow keys ALWAYS scrub the UP NEXT (idle) deck safely (never move search cursor)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (document.querySelector('[role="dialog"]')) return;
      const target = e.target as HTMLElement | null;
      if (target?.getAttribute("role") === "slider") return;

      e.preventDefault();
      if (!idleSnapshot.track || idleSnapshot.waveformLocked) return;
      const step = e.shiftKey ? 1 : 5;
      djEngine.seekBySeconds(idleDeck, e.key === "ArrowRight" ? step : -step);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [idleDeck, idleSnapshot.track, idleSnapshot.waveformLocked]);

  // Mark tracks as "Played" after 30s of live playback
  useEffect(() => {
    if (!liveSnapshot?.track || !liveSnapshot.isPlaying) return;
    if (liveSnapshot.currentTime >= 30 && !playedIds.has(liveSnapshot.track.id)) {
      const id = liveSnapshot.track.id;
      setPlayedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }
  }, [liveSnapshot?.track, liveSnapshot?.isPlaying, liveSnapshot?.currentTime, playedIds]);

  // Pop next song from queue into a freshly freed deck
  const stageNextFromQueue = useCallback(
    (targetDeck: DeckId) => {
      const currentQ = queueRef.current;
      if (currentQ.length === 0) return;
      const [nextEntry, ...rest] = currentQ;
      if (!nextEntry) return;
      setQueue(rest);
      void djEngine.loadTrack(targetDeck, nextEntry.track);
      flashDeck(targetDeck);
    },
    [flashDeck],
  );

  // Auto-stage first queued track into the idle deck if idle deck is empty
  useEffect(() => {
    if (!idleSnapshot.track && queue.length > 0 && !isAutoFading) {
      stageNextFromQueue(idleDeck);
    }
  }, [idleSnapshot.track, queue.length, idleDeck, isAutoFading, stageNextFromQueue]);

  // Auto-Play safety net:
  // 1) If queue & idle deck are empty near the end of the live song, auto-pick a random
  //    unplayed cached track with a close BPM and stage it on the idle deck.
  // 2) Auto-crossfade before the audible end (skipping quiet outro tails).
  useEffect(() => {
    if (!autoPlayEnabled || isAutoFading || !liveDeck || !liveSnapshot?.track) return;

    const effectiveEnd =
      liveSnapshot.cueOutSec > 0
        ? Math.min(liveSnapshot.duration, liveSnapshot.cueOutSec)
        : liveSnapshot.duration;
    const plannedFadeSec = upcomingTransitionPlan
      ? upcomingTransitionPlan.durationMs / 1000
      : fadeSeconds;
    const triggerLeadSec = plannedFadeSec + AUTO_FADE_LEAD_BUFFER_SEC;
    if (effectiveEnd <= triggerLeadSec + 2) return;

    const remaining = effectiveEnd - liveSnapshot.currentTime;
    const triggerKey = `${liveDeck}:${liveSnapshot.track.id}`;

    // Pre-stage a close-BPM random track ~8s before the auto-fade point if nothing is queued
    if (
      !idleSnapshot.track &&
      queue.length === 0 &&
      tracks.length > 1 &&
      remaining <= triggerLeadSec + 8 &&
      autoPickTriggeredForRef.current !== triggerKey
    ) {
      const excludeIds = new Set<string>();
      if (deckA.track) excludeIds.add(deckA.track.id);
      if (deckB.track) excludeIds.add(deckB.track.id);

      const picked = pickAutoNextTrack(tracks, {
        referenceBpm: liveSnapshot.bpm ?? liveSnapshot.track.bpm,
        playedIds,
        excludeIds,
      });

      if (picked) {
        autoPickTriggeredForRef.current = triggerKey;
        void djEngine.loadTrack(idleDeck, picked);
        flashDeck(idleDeck);
        toast.info(
          picked.bpm
            ? `Auto-picked “${picked.title}” (${picked.bpm} BPM)`
            : `Auto-picked “${picked.title}”`,
        );
        return;
      }
    }

    if (
      remaining <= triggerLeadSec &&
      remaining > 0.2 &&
      idleSnapshot.track &&
      autoFadeTriggeredForRef.current !== triggerKey
    ) {
      autoFadeTriggeredForRef.current = triggerKey;
      const moveLabel = upcomingTransitionPlan ? ` (${upcomingTransitionPlan.label})` : "";
      toast.info(`Auto-fading to ${idleSnapshot.track.title}${moveLabel}`);
      void djEngine.startAutoFade(
        idleDeck,
        fadeSeconds * 1000,
        (oldDeck) => {
          autoFadeTriggeredForRef.current = null;
          autoPickTriggeredForRef.current = null;
          stageNextFromQueue(oldDeck);
        },
        mixMode,
      );
    }
  }, [
    autoPlayEnabled,
    isAutoFading,
    liveDeck,
    liveSnapshot,
    idleDeck,
    idleSnapshot.track,
    deckA.track,
    deckB.track,
    queue.length,
    tracks,
    playedIds,
    fadeSeconds,
    mixMode,
    upcomingTransitionPlan,
    flashDeck,
    stageNextFromQueue,
  ]);

  const applyLoadedTracks = useCallback((name: string, loaded: TrackItem[]) => {
    setTracks(loaded);
    hydratingRef.current.clear();
    metaQueueRef.current = [];
    autoFadeTriggeredForRef.current = null;
    autoPickTriggeredForRef.current = null;
    bpmScheduler.reset();

    if (loaded.length === 0) {
      toast.error("No supported audio files found in that folder.");
      return;
    }

    toast.success(`Loaded ${loaded.length} songs from ${name}`);

    // Batch-restore all cached titles, covers, and BPMs in one IndexedDB read,
    // then trickle-calculate remaining BPMs in a Web Worker in the background
    void hydrateCachedLibrary(loaded).then((hydrated) => {
      setTracks(hydrated);
      bpmScheduler.enqueueMany(hydrated, "low");
    });
  }, []);

  const handleOpenFolder = useCallback(async () => {
    if (supportsDirectoryPicker()) {
      try {
        const res = await pickDirectoryTracks();
        if (res) {
          setSavedFolderName(res.folderName);
          applyLoadedTracks(res.folderName, res.tracks);
        }
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    fileInputRef.current?.click();
  }, [applyLoadedTracks]);

  const handleReconnectFolder = useCallback(async () => {
    try {
      const res = await reconnectSavedFolder();
      if (res) {
        applyLoadedTracks(res.folderName, res.tracks);
      } else {
        toast.info("Please pick your music folder again to grant read permission.");
        await handleOpenFolder();
      }
    } catch {
      await handleOpenFolder();
    }
  }, [applyLoadedTracks, handleOpenFolder]);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const firstPath = files[0]?.webkitRelativePath ?? "";
    const folder = firstPath.split("/")[0] || "Music Folder";
    applyLoadedTracks(folder, filesToTrackItems(files));
    e.target.value = "";
  };

  const drainMetaQueue = useCallback(() => {
    while (metaActiveCountRef.current < 3 && metaQueueRef.current.length > 0) {
      const nextTrack = metaQueueRef.current.shift();
      if (!nextTrack) break;
      metaActiveCountRef.current++;
      void hydrateTrackMetadata(nextTrack)
        .then((patch) => {
          setTracks((prev) =>
            prev.map((item) => (item.id === nextTrack.id ? { ...item, ...patch } : item)),
          );
        })
        .finally(() => {
          metaActiveCountRef.current--;
          drainMetaQueue();
        });
    }
  }, []);

  const handleRequestMetadata = useCallback(
    (track: TrackItem) => {
      if (track.metadataLoaded || hydratingRef.current.has(track.id)) return;
      hydratingRef.current.add(track.id);
      metaQueueRef.current.push(track);
      drainMetaQueue();
    },
    [drainMetaQueue],
  );

  const handleLoadNext = useCallback(
    (track: TrackItem, force = false) => {
      if (!force && playedIds.has(track.id)) {
        toast.warning(`“${track.title}” was already played this session`, {
          action: {
            label: "Load anyway",
            onClick: () => handleLoadNext(track, true),
          },
        });
        return;
      }

      // If neither deck has a track, load Deck A, route crossfader to A, and start playing immediately
      if (!deckA.track && !deckB.track) {
        djEngine.setCrossfade(0, false);
        void djEngine.loadTrack("A", track);
        void djEngine.play("A");
        flashDeck("A");
        toast.success(`Playing “${track.title}” on Deck A`);
        return;
      }

      const target = idleDeck;
      if (target === liveDeck) {
        toast.error("Cannot overwrite the ON AIR deck while it is playing.");
        return;
      }
      void djEngine.loadTrack(target, track);
      flashDeck(target);
      toast.success(`Loaded “${track.title}” onto Deck ${target} (Up Next)`);
    },
    [deckA.track, deckB.track, flashDeck, idleDeck, liveDeck, playedIds],
  );

  const ensureTrackBpm = useCallback((track: TrackItem) => {
    bpmScheduler.enqueue(track, "queued");
  }, []);

  const handlePrioritizeBpm = useCallback(
    (selected: TrackItem, neighbors: TrackItem[]) => {
      bpmScheduler.setFocusWindow(selected, neighbors);
    },
    [],
  );

  const handleScrollActivity = useCallback(() => {
    bpmScheduler.notifyScrollActivity(220);
  }, []);

  const handleAddToQueue = useCallback(
    (track: TrackItem, force = false) => {
      if (queueRef.current.some((entry) => entry.track.id === track.id)) {
        toast.info(`“${track.title}” is already in the queue`);
        return;
      }

      if (idleSnapshot.track?.id === track.id) {
        toast.info(`“${track.title}” is already staged on Deck ${idleDeck}`);
        return;
      }

      if (!force && playedIds.has(track.id)) {
        toast.warning(`“${track.title}” was already played this session`, {
          action: {
            label: "Queue anyway",
            onClick: () => handleAddToQueue(track, true),
          },
        });
        return;
      }

      if (!deckA.track && !deckB.track) {
        djEngine.setCrossfade(0, false);
        void djEngine.loadTrack("A", track);
        flashDeck("A");
        toast.success(`Loaded “${track.title}” onto Deck A`);
        return;
      }
      if (!idleSnapshot.track) {
        void djEngine.loadTrack(idleDeck, track);
        flashDeck(idleDeck);
        toast.success(`Staged “${track.title}” on Deck ${idleDeck} (Up Next)`);
        return;
      }
      const uid = `q-${++queueSeqRef.current}-${track.id}`;
      setQueue((prev) => [...prev, { uid, track }]);
      ensureTrackBpm(track);
      toast.success(`Added “${track.title}” to queue`);
    },
    [deckA.track, deckB.track, ensureTrackBpm, flashDeck, idleDeck, idleSnapshot.track, playedIds],
  );

  const handleAutoFade = useCallback(() => {
    if (isAutoFading) return;
    if (!idleSnapshot.track) {
      toast.error("Load or queue a song for the next deck first.");
      return;
    }
    void djEngine.startAutoFade(
      idleDeck,
      fadeSeconds * 1000,
      (oldDeck) => {
        autoFadeTriggeredForRef.current = null;
        autoPickTriggeredForRef.current = null;
        stageNextFromQueue(oldDeck);
      },
      mixMode,
    );
  }, [idleDeck, idleSnapshot.track, isAutoFading, fadeSeconds, mixMode, stageNextFromQueue]);

  // Solo Shift tap triggers Fade to Next even while searching (still ignored if combined with another key)
  useEffect(() => {
    let shiftSolo = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        if (e.repeat) return;
        if (document.querySelector('[role="dialog"]')) return;
        shiftSolo = true;
      } else if (shiftSolo) {
        shiftSolo = false;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift" && shiftSolo) {
        shiftSolo = false;
        handleAutoFade();
      }
    };

    const onBlur = () => {
      shiftSolo = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [handleAutoFade]);

  const handleClearQueue = useCallback(() => {
    const backup = queue;
    setQueue([]);
    toast("Queue cleared", {
      action: {
        label: "Undo",
        onClick: () => setQueue(backup),
      },
    });
  }, [queue]);

  const handleLoadFromQueue = useCallback(
    (index: number) => {
      const targetEntry = queue[index];
      if (!targetEntry) return;

      const targetDeck = idleDeck;
      if (targetDeck === liveDeck) {
        toast.error("Cannot overwrite the ON AIR deck while it is playing.");
        return;
      }

      const prevStaged = idleSnapshot.track;
      setQueue((prev) => {
        const rest = prev.filter((_, i) => i !== index);
        if (prevStaged && prevStaged.id !== targetEntry.track.id) {
          const uid = `q-${++queueSeqRef.current}-${prevStaged.id}`;
          return [{ uid, track: prevStaged }, ...rest];
        }
        return rest;
      });

      void djEngine.loadTrack(targetDeck, targetEntry.track);
      flashDeck(targetDeck);
      toast.success(`Loaded “${targetEntry.track.title}” onto Deck ${targetDeck}`);
    },
    [queue, idleDeck, liveDeck, idleSnapshot.track, flashDeck],
  );

  const handleMoveQueue = useCallback((from: number, to: number) => {
    setQueue((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      if (!moved) return prev;
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const sortedTracks = useMemo(() => {
    const copy = [...tracks];
    copy.sort((a, b) => {
      const av =
        sortMode === "artist"
          ? a.artist
          : sortMode === "filename"
            ? a.filename
            : a.title;
      const bv =
        sortMode === "artist"
          ? b.artist
          : sortMode === "filename"
            ? b.filename
            : b.title;
      return av.localeCompare(bv, undefined, { sensitivity: "base" });
    });
    return copy;
  }, [tracks, sortMode]);

  const filteredTracks = useMemo(
    () => searchTracks(sortedTracks, query),
    [sortedTracks, query],
  );

  const ThemeIcon = theme === "light" ? Sun : theme === "oled" ? Monitor : Moon;

  return (
    <div
      className={cn(
        "relative flex h-dvh flex-col overflow-hidden bg-bg text-fg",
        "pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]",
        isDesktop ? "pb-[env(safe-area-inset-bottom)]" : "pb-0",
      )}
      style={
        {
          "--tab-bar": "4.5rem",
          "--under-tabs": isDesktop
            ? "0px"
            : "calc(var(--tab-bar) + env(safe-area-inset-bottom))",
        } as React.CSSProperties
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        webkitdirectory=""
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Top App Bar */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-card/80 px-3 py-1.5 backdrop-blur-sm md:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="shrink-0 text-xs font-bold tracking-wider text-fg uppercase">
            Portable DJ
          </h1>
          <SoundboardBar
            pads={soundPads}
            activePadIds={activePadIds}
            onTriggerPad={triggerSoundPad}
            onAddPad={handleAddSoundPad}
            onRemovePad={handleRemoveSoundPad}
          />
        </div>

        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-bg/60 px-2 py-0.5 text-xs">
            <Switch
              checked={autoPlayEnabled}
              onCheckedChange={setAutoPlayEnabled}
              aria-label="Toggle Auto-Play Queue"
            />
            <span className="hidden font-medium sm:inline">Auto-Play</span>
          </label>

          <div className="hidden w-28 items-center gap-1.5 lg:flex">
            <Volume2 className="size-3.5 shrink-0 text-dim" />
            <Slider
              aria-label="Master Volume"
              min={0}
              max={100}
              step={1}
              value={[Math.round(masterVolume * 100)]}
              onValueChange={(vals) => djEngine.setMasterVolume((vals[0] ?? 85) / 100)}
            />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-xs" variant="outline" aria-label="Switch theme">
                <ThemeIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(Object.keys(THEMES) as ThemeName[]).map((name) => (
                <DropdownMenuItem key={name} onClick={() => setTheme(name)}>
                  {THEMES[name].label}
                  {theme === name && " •"}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {typeof document !== "undefined" && document.fullscreenEnabled && (
            <Button
              size="icon-xs"
              variant="outline"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </Button>
          )}

          {canInstall && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void install()}
              title="Install Portable DJ as an offline app"
            >
              <Download className="size-3.5" />
              <span className="hidden md:inline">Install</span>
            </Button>
          )}

          <Button size="xs" onClick={handleOpenFolder}>
            <FolderOpen className="size-3.5" />
            <span className="hidden sm:inline">Open Folder</span>
          </Button>
        </div>
      </header>

      {/* Main Content — Desktop vs Phone Shell */}
      {isDesktop ? (
        <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 md:p-4">
          <div className="grid shrink-0 grid-cols-1 gap-3 md:grid-cols-[1fr_228px_1fr]">
            <DeckCard
              deckId="A"
              deck={deckA}
              isLive={liveDeck === "A"}
              audibility={audibilityA}
              isEndingSoon={isAEndingSoon}
              playBlockedByFader={playBlockedA}
              loadFlashKey={loadFlashA}
              onPlay={() => handlePlayDeck("A")}
              onSoftStop={() => djEngine.softStop("A")}
              onSeek={(r) => djEngine.seek("A", r)}
              onToggleLock={() => djEngine.toggleWaveformLock("A")}
            />
            <CrossfaderPanel
              crossfade={crossfade}
              isAutoFading={isAutoFading}
              fadeSeconds={fadeSeconds}
              mixMode={mixMode}
              transitionLabel={transitionBadgeLabel}
              nextDeck={idleDeck}
              canAutoFade={Boolean(idleSnapshot.track)}
              onCrossfadeChange={(v) => djEngine.setCrossfade(v, true)}
              onAutoFade={handleAutoFade}
              onFadeSecondsChange={setFadeSeconds}
              onMixModeChange={setMixMode}
            />
            <DeckCard
              deckId="B"
              deck={deckB}
              isLive={liveDeck === "B"}
              audibility={audibilityB}
              isEndingSoon={isBEndingSoon}
              playBlockedByFader={playBlockedB}
              loadFlashKey={loadFlashB}
              onPlay={() => handlePlayDeck("B")}
              onSoftStop={() => djEngine.softStop("B")}
              onSeek={(r) => djEngine.seek("B", r)}
              onToggleLock={() => djEngine.toggleWaveformLock("B")}
            />
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[1.65fr_1fr]">
            <LibraryPanel
              tracks={filteredTracks}
              totalCount={tracks.length}
              query={query}
              sortMode={sortMode}
              savedFolderName={savedFolderName}
              deckATrackId={deckA.track?.id ?? null}
              deckBTrackId={deckB.track?.id ?? null}
              liveDeck={liveDeck}
              referenceBpm={referenceBpm}
              playedIds={playedIds}
              onQueryChange={onQueryChange}
              onSortChange={onSortChange}
              onOpenFolder={handleOpenFolder}
              onReconnectFolder={handleReconnectFolder}
              onLoadNext={handleLoadNext}
              onAddToQueue={handleAddToQueue}
              onRequestMetadata={handleRequestMetadata}
              onPrioritizeBpm={handlePrioritizeBpm}
              onScrollActivity={handleScrollActivity}
            />
            <QueuePanel
              queue={queue}
              liveBpm={liveSnapshot?.bpm ?? deckA.bpm ?? deckB.bpm}
              stagedTrack={idleSnapshot.track}
              stagedBpm={idleSnapshot.bpm}
              stagedDeck={idleDeck}
              autoPlayEnabled={autoPlayEnabled}
              onReorder={setQueue}
              onLoadAt={handleLoadFromQueue}
              onRemoveAt={(idx) => setQueue((prev) => prev.filter((_, i) => i !== idx))}
              onMove={handleMoveQueue}
              onClear={handleClearQueue}
            />
          </div>
        </main>
      ) : (
        <>
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
            {mobileTab === "decks" && (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-[calc(var(--under-tabs)+1rem)]">
                <DeckCard
                  deckId="A"
                  deck={deckA}
                  isLive={liveDeck === "A"}
                  audibility={audibilityA}
                  isEndingSoon={isAEndingSoon}
                  playBlockedByFader={playBlockedA}
                  loadFlashKey={loadFlashA}
                  onPlay={() => handlePlayDeck("A")}
                  onSoftStop={() => djEngine.softStop("A")}
                  onSeek={(r) => djEngine.seek("A", r)}
                  onToggleLock={() => djEngine.toggleWaveformLock("A")}
                />
                <CrossfaderPanel
                  crossfade={crossfade}
                  isAutoFading={isAutoFading}
                  fadeSeconds={fadeSeconds}
                  mixMode={mixMode}
                  transitionLabel={transitionBadgeLabel}
                  nextDeck={idleDeck}
                  canAutoFade={Boolean(idleSnapshot.track)}
                  onCrossfadeChange={(v) => djEngine.setCrossfade(v, true)}
                  onAutoFade={handleAutoFade}
                  onFadeSecondsChange={setFadeSeconds}
                  onMixModeChange={setMixMode}
                />
                <DeckCard
                  deckId="B"
                  deck={deckB}
                  isLive={liveDeck === "B"}
                  audibility={audibilityB}
                  isEndingSoon={isBEndingSoon}
                  playBlockedByFader={playBlockedB}
                  loadFlashKey={loadFlashB}
                  onPlay={() => handlePlayDeck("B")}
                  onSoftStop={() => djEngine.softStop("B")}
                  onSeek={(r) => djEngine.seek("B", r)}
                  onToggleLock={() => djEngine.toggleWaveformLock("B")}
                />
              </div>
            )}

            {mobileTab === "library" && (
              <LibraryPanel
                tracks={filteredTracks}
                totalCount={tracks.length}
                query={query}
                sortMode={sortMode}
                savedFolderName={savedFolderName}
                deckATrackId={deckA.track?.id ?? null}
                deckBTrackId={deckB.track?.id ?? null}
                liveDeck={liveDeck}
                referenceBpm={referenceBpm}
                playedIds={playedIds}
                onQueryChange={onQueryChange}
                onSortChange={onSortChange}
                onOpenFolder={handleOpenFolder}
                onReconnectFolder={handleReconnectFolder}
                onLoadNext={handleLoadNext}
                onAddToQueue={handleAddToQueue}
                onRequestMetadata={handleRequestMetadata}
                onPrioritizeBpm={handlePrioritizeBpm}
                onScrollActivity={handleScrollActivity}
              />
            )}

            {mobileTab === "queue" && (
              <QueuePanel
                queue={queue}
                liveBpm={liveSnapshot?.bpm ?? deckA.bpm ?? deckB.bpm}
                stagedTrack={idleSnapshot.track}
                stagedBpm={idleSnapshot.bpm}
                stagedDeck={idleDeck}
                autoPlayEnabled={autoPlayEnabled}
                onReorder={setQueue}
                onLoadAt={handleLoadFromQueue}
                onRemoveAt={(idx) => setQueue((prev) => prev.filter((_, i) => i !== idx))}
                onMove={handleMoveQueue}
                onClear={handleClearQueue}
              />
            )}
          </main>

          {/* Floating Mobile Bottom Tab Bar */}
          <nav
            aria-label="Primary Navigation"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          >
            <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-line bg-card/95 p-1.5 shadow-lg backdrop-blur-md">
              {(
                [
                  { id: "decks", label: "Decks", icon: Disc3 },
                  { id: "library", label: "Library", icon: Music },
                  { id: "queue", label: `Queue (${queue.length})`, icon: ListMusic },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const active = mobileTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => onMobileTabChange(tab.id)}
                    className={cn(
                      "flex min-h-10 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition-colors",
                      active
                        ? "bg-brand-soft text-brand"
                        : "text-dim hover:bg-raised hover:text-fg",
                    )}
                  >
                    <Icon className="size-4" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
