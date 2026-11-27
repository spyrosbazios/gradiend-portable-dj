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
  findCueSpot,
  getActiveExitSpot,
  getExitQualityAtTime,
  getIdleDeck,
  getLiveDeck,
  getNextBeatOneSec,
  isDeckFadedOut,
  pickAutoNextTrack,
  planMixTransition,
  evaluateBpmFit,
  barFadeDurationMs,
  mixTempo,
  type FadeBars,
  type DeckId,
  type MixMode,
  type SpotQuality,
  type TrackCues,
} from "@/core/dj-math";
import { keyFit } from "@/core/key-detect";
import { THEMES, type ThemeName } from "@/core/theme";
import { djEngine, type TrackItem } from "@/lib/audio-engine";
import { analysisScheduler } from "@/lib/analysis-scheduler";
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

const AUTO_MIX_FLAG_LEAD_SEC = 0.5;
const FALLBACK_AUTO_FADE_LEAD_BUFFER_SEC = 2.5;
const BPM_MATCH_LIMIT = 40;
const MIX_MODE_STORAGE_KEY = "portable-dj:mix-mode";
const trackCollator = new Intl.Collator(undefined, { sensitivity: "base" });

function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

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
  const [fadeBars, setFadeBars] = useState<FadeBars>(16);
  const [mixMode, setMixMode] = useState<MixMode>(readInitialMixMode);

  useEffect(() => {
    djEngine.setMixMode(mixMode);
    try {
      localStorage.setItem(MIX_MODE_STORAGE_KEY, mixMode);
    } catch {
      // ignore storage errors
    }
  }, [mixMode]);

  useEffect(() => {
    djEngine.setFadeBars(fadeBars);
  }, [fadeBars]);
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
  const folderLoadSeqRef = useRef(0);
  const autoFadeTriggeredForRef = useRef<string | null>(null);
  const autoPickTriggeredForRef = useRef<string | null>(null);
  const queueSeqRef = useRef(0);
  const queueRef = useRef<QueueEntry[]>(queue);
  queueRef.current = queue;
  const tracksRef = useRef<TrackItem[]>(tracks);
  tracksRef.current = tracks;
  const playedIdsRef = useRef<Set<string>>(playedIds);
  playedIdsRef.current = playedIds;
  const autoPlayRef = useRef<boolean>(autoPlayEnabled);
  autoPlayRef.current = autoPlayEnabled;

  // Subscribe to Web Audio engine snapshots
  const engineVersion = useSyncExternalStore(
    (cb) => djEngine.subscribe(cb),
    () => {
      const a = djEngine.getDeck("A");
      const b = djEngine.getDeck("B");
      return `${a.currentTime.toFixed(1)}:${a.isPlaying}:${a.track?.id ?? ""}:${a.peaks.length}:${a.bpm ?? ""}:${a.cues?.bestExitBar ?? ""}:${a.selectedEntryBar ?? ""}:${a.waveformLocked}|${b.currentTime.toFixed(1)}:${b.isPlaying}:${b.track?.id ?? ""}:${b.peaks.length}:${b.bpm ?? ""}:${b.cues?.bestExitBar ?? ""}:${b.selectedEntryBar ?? ""}:${b.waveformLocked}|${djEngine.getCrossfade().toFixed(3)}:${djEngine.getIsAutoFading()}:${djEngine.getActiveTransitionLabel() ?? ""}:${djEngine.getMasterVolume().toFixed(2)}`;
    },
  );
  void engineVersion;

  const deckA = djEngine.getDeck("A");
  const deckB = djEngine.getDeck("B");
  const crossfade = djEngine.getCrossfade();
  const masterVolume = djEngine.getMasterVolume();
  const isAutoFading = djEngine.getIsAutoFading();
  const isMixing = djEngine.getIsMixing();
  const activeTransitionLabel = djEngine.getActiveTransitionLabel();

  const liveDeck = getLiveDeck(crossfade, deckA.isPlaying, deckB.isPlaying);
  const idleDeck = getIdleDeck(crossfade, deckA.isPlaying, deckB.isPlaying);
  const idleSnapshot = idleDeck === "A" ? deckA : deckB;
  const liveSnapshot = liveDeck === "A" ? deckA : liveDeck === "B" ? deckB : null;

  const isAEndingSoon =
    deckA.isPlaying && deckA.duration > 30 && deckA.duration - deckA.currentTime <= 30;
  const isBEndingSoon =
    deckB.isPlaying && deckB.duration > 30 && deckB.duration - deckB.currentTime <= 30;

  const { gainA, gainB } = equalPowerGains(crossfade);
  const audibilityA = deckA.isPlaying ? gainA : 0;
  const audibilityB = deckB.isPlaying ? gainB : 0;

  // Reference BPM for library arrow-navigation color-coding:
  // compares against the tail of the queue if non-empty, else the staged UP NEXT deck, else the live deck
  const lastQueuedBpm = queue.length > 0 ? (queue[queue.length - 1]?.track.bpm ?? null) : null;
  const referenceBpm =
    lastQueuedBpm ?? idleSnapshot.bpm ?? liveSnapshot?.bpm ?? deckA.bpm ?? deckB.bpm ?? null;

  // Harmonic fit of the UP NEXT track against the live one (Camelot wheel).
  const nextKeyFit = keyFit(liveSnapshot?.cues?.key ?? null, idleSnapshot.cues?.key ?? null);

  // Spyros can cancel the auto mix-out for the current live track; keyed by deck+track so the
  // next track gets its flag back automatically.
  const [skippedMixOutKey, setSkippedMixOutKey] = useState<string | null>(null);
  const liveMixOutKey = liveDeck && liveSnapshot?.track ? `${liveDeck}:${liveSnapshot.track.id}` : null;
  const mixOutSkipped = liveMixOutKey !== null && skippedMixOutKey === liveMixOutKey;
  const handleToggleMixOut = useCallback(() => {
    if (!liveMixOutKey) return;
    setSkippedMixOutKey((prev) => (prev === liveMixOutKey ? null : liveMixOutKey));
  }, [liveMixOutKey]);

  const liveExitSpot = useMemo(
    () =>
      liveSnapshot && !mixOutSkipped
        ? getActiveExitSpot(liveSnapshot.cues, liveSnapshot.currentTime)
        : null,
    [liveSnapshot, mixOutSkipped],
  );

  const idleEntrySpot = useMemo(
    () =>
      idleSnapshot.cues
        ? findCueSpot(
            idleSnapshot.cues.entries,
            idleSnapshot.selectedEntryBar ?? idleSnapshot.cues.bestEntryBar,
          )
        : null,
    [idleSnapshot.cues, idleSnapshot.selectedEntryBar],
  );

  const upcomingTransitionPlan = useMemo(() => {
    if (!idleSnapshot.track) return null;
    if (!liveSnapshot?.isPlaying) {
      return planMixTransition({
        mode: "classic",
        fromBpm: null,
        toBpm: idleSnapshot.bpm ?? idleSnapshot.track.bpm,
        fadeBars,
      });
    }
    const liveCues = liveSnapshot.cues;
    const idleCues = idleSnapshot.cues;
    const confidence: "high" | "low" | undefined =
      liveCues && idleCues
        ? liveCues.confidence === "high" &&
          idleCues.confidence === "high" &&
          liveCues.grid !== null &&
          idleCues.grid !== null
          ? "high"
          : "low"
        : liveCues?.confidence === "low" || idleCues?.confidence === "low"
          ? "low"
          : undefined;
    const fromBpm = mixTempo(liveCues, liveSnapshot.bpm ?? liveSnapshot.track?.bpm ?? null);
    const mixStartSec = liveExitSpot?.sec ?? liveSnapshot.currentTime;
    return planMixTransition({
      mode: mixMode,
      fromBpm,
      toBpm: mixTempo(idleCues, idleSnapshot.bpm ?? idleSnapshot.track.bpm),
      fadeBars,
      barsAvailable:
        liveSnapshot.duration > 0
          ? (liveSnapshot.duration - mixStartSec) / (barFadeDurationMs(fromBpm, 1) / 1000)
          : undefined,
      confidence,
      exitQuality: liveExitSpot?.quality ?? null,
      entryQuality: idleEntrySpot?.quality ?? null,
      keyFit: nextKeyFit,
    });
  }, [
    idleSnapshot.track,
    idleSnapshot.bpm,
    idleSnapshot.cues,
    idleEntrySpot?.quality,
    liveSnapshot?.isPlaying,
    liveSnapshot?.bpm,
    liveSnapshot?.track?.bpm,
    liveSnapshot?.cues,
    liveSnapshot?.duration,
    liveSnapshot?.currentTime,
    liveExitSpot?.quality,
    liveExitSpot?.sec,
    nextKeyFit,
    mixMode,
    fadeBars,
  ]);

  const transitionBadgeLabel = useMemo(() => {
    if (activeTransitionLabel) return activeTransitionLabel;
    if (mixOutSkipped && autoPlayEnabled) return "Auto mix-out off for this track";
    // Auto-play mixes out even before UP NEXT is staged, so the badge (and its cancel button)
    // must show whenever a mix-out is coming, not only once a plan exists.
    const planLabel = upcomingTransitionPlan?.label ?? (autoPlayEnabled ? "Auto mix-out" : null);
    if (!planLabel) return null;
    if (liveSnapshot?.isPlaying && liveExitSpot) {
      const secsUntilFlag = Math.max(0, liveExitSpot.sec - liveSnapshot.currentTime);
      return `In ${formatCountdown(secsUntilFlag)} · ${planLabel}`;
    }
    return upcomingTransitionPlan ? planLabel : null;
  }, [
    isAutoFading,
    activeTransitionLabel,
    upcomingTransitionPlan,
    liveSnapshot?.isPlaying,
    liveSnapshot?.currentTime,
    liveExitSpot,
    mixOutSkipped,
    autoPlayEnabled,
  ]);

  const nextBeatQuality: SpotQuality | null = useMemo(() => {
    if (!liveSnapshot?.isPlaying || !idleSnapshot.track) return null;
    if (!liveSnapshot.cues?.grid) return "ok";
    const nextBeat1 = getNextBeatOneSec(liveSnapshot.cues.grid, liveSnapshot.currentTime);
    return getExitQualityAtTime(liveSnapshot.cues, nextBeat1);
  }, [
    liveSnapshot?.isPlaying,
    liveSnapshot?.cues,
    liveSnapshot?.currentTime,
    idleSnapshot.track,
  ]);

  const entrySpotA = useMemo(
    () =>
      deckA.cues
        ? findCueSpot(deckA.cues.entries, deckA.selectedEntryBar ?? deckA.cues.bestEntryBar)
        : null,
    [deckA.cues, deckA.selectedEntryBar],
  );
  const entrySpotB = useMemo(
    () =>
      deckB.cues
        ? findCueSpot(deckB.cues.entries, deckB.selectedEntryBar ?? deckB.cues.bestEntryBar)
        : null,
    [deckB.cues, deckB.selectedEntryBar],
  );

  const entryIdxA =
    deckA.cues && entrySpotA
      ? deckA.cues.entries.findIndex((s) => s.bar === entrySpotA.bar)
      : -1;
  const entryIdxB =
    deckB.cues && entrySpotB
      ? deckB.cues.entries.findIndex((s) => s.bar === entrySpotB.bar)
      : -1;

  const canStepPrevA = deckA.cues?.entries.length ? entryIdxA > 0 : deckA.currentTime > 0;
  const canStepNextA = deckA.cues?.entries.length
    ? entryIdxA >= 0 && entryIdxA < deckA.cues.entries.length - 1
    : deckA.duration > 0;
  const canStepPrevB = deckB.cues?.entries.length ? entryIdxB > 0 : deckB.currentTime > 0;
  const canStepNextB = deckB.cues?.entries.length
    ? entryIdxB >= 0 && entryIdxB < deckB.cues.entries.length - 1
    : deckB.duration > 0;

  const exitSpotA = useMemo(
    () =>
      liveDeck === "A" && !mixOutSkipped ? getActiveExitSpot(deckA.cues, deckA.currentTime) : null,
    [liveDeck, deckA.cues, deckA.currentTime, mixOutSkipped],
  );
  const exitSpotB = useMemo(
    () =>
      liveDeck === "B" && !mixOutSkipped ? getActiveExitSpot(deckB.cues, deckB.currentTime) : null,
    [liveDeck, deckB.cues, deckB.currentTime, mixOutSkipped],
  );

  const handlePlayDeck = useCallback(
    (id: DeckId) => {
      const otherPlaying = id === "A" ? deckB.isPlaying : deckA.isPlaying;
      const fadedOut = isDeckFadedOut(id, crossfade);

      if (fadedOut) {
        if (otherPlaying) {
          toast.info(`Deck ${id} starts muted — move the crossfader or tap Shift to bring it in.`);
        } else {
          // Nothing is playing: automatically route crossfader to the deck the user wants to start
          djEngine.setCrossfade(id === "A" ? 0 : 1, false);
        }
      }

      // Bringing in the next song: start it from its flagged entry point.
      if (otherPlaying && !djEngine.getDeck(id).isPlaying) djEngine.cueToSelectedEntry(id);

      void djEngine.play(id).then((ok) => {
        if (!ok) {
          const title = djEngine.getDeck(id).track?.title ?? `Deck ${id}`;
          toast.error(`Could not play “${title}”. The audio file may be unreadable.`);
        }
      });
    },
    [crossfade, deckA.isPlaying, deckB.isPlaying],
  );

  const handlePlayA = useCallback(() => handlePlayDeck("A"), [handlePlayDeck]);
  const handlePlayB = useCallback(() => handlePlayDeck("B"), [handlePlayDeck]);
  const handleSoftStopA = useCallback(() => djEngine.softStop("A"), []);
  const handleSoftStopB = useCallback(() => djEngine.softStop("B"), []);
  const handleSeekA = useCallback((r: number) => djEngine.seek("A", r), []);
  const handleSeekB = useCallback((r: number) => djEngine.seek("B", r), []);
  const handleToggleLockA = useCallback(() => djEngine.toggleWaveformLock("A"), []);
  const handleToggleLockB = useCallback(() => djEngine.toggleWaveformLock("B"), []);
  const handleStepEntryA = useCallback((delta: -1 | 1) => djEngine.stepSelectedEntry("A", delta), []);
  const handleStepEntryB = useCallback((delta: -1 | 1) => djEngine.stepSelectedEntry("B", delta), []);
  const handleCrossfadeChange = useCallback((v: number) => djEngine.setCrossfade(v, true), []);
  const handleRemoveQueueAt = useCallback((idx: number) => {
    setQueue((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  useEffect(() => {
    void getSavedFolderName().then(setSavedFolderName);
  }, []);

  // Wire Web Worker background analysis scheduler results into tracks + queue (batched to avoid 400 re-sorts)
  useEffect(() => {
    const pending = new Map<string, { bpm: number | null; cues: TrackCues }>();
    let flushTimer: number | null = null;

    const flush = () => {
      flushTimer = null;
      if (pending.size === 0) return;
      const batch = new Map(pending);
      pending.clear();

      setTracks((prev) => {
        let changed = false;
        const next = prev.map((item) => {
          const res = batch.get(item.id);
          if (!res) return item;
          const nextBpm = res.bpm ?? item.bpm;
          if (item.bpm === nextBpm && item.cues === res.cues) return item;
          changed = true;
          return { ...item, bpm: nextBpm, cues: res.cues };
        });
        return changed ? next : prev;
      });

      setQueue((prev) => {
        if (prev.length === 0) return prev;
        let changed = false;
        const next = prev.map((entry) => {
          const res = batch.get(entry.track.id);
          if (!res) return entry;
          const nextBpm = res.bpm ?? entry.track.bpm;
          if (entry.track.bpm === nextBpm && entry.track.cues === res.cues) return entry;
          changed = true;
          return { ...entry, track: { ...entry.track, bpm: nextBpm, cues: res.cues } };
        });
        return changed ? next : prev;
      });
    };

    analysisScheduler.setListener((trackId, bpm, cues) => {
      pending.set(trackId, { bpm, cues });
      if (flushTimer === null) {
        flushTimer = window.setTimeout(flush, 250);
      }
    });

    return () => {
      analysisScheduler.setListener(null);
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
      }
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

  // Left/Right arrow keys step the UP NEXT deck's entry phrase flag (shortcut to ‹ › buttons)
  // Ignored while focus is in an input (e.g. library search), dialog, or slider.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (document.querySelector('[role="dialog"]')) return;
      const target = e.target as HTMLElement | null;
      const inInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      if (inInput) return;
      if (target?.getAttribute("role") === "slider") return;

      if (isMixing || !idleSnapshot.track) return;
      e.preventDefault();
      const stepHandler = idleDeck === "A" ? handleStepEntryA : handleStepEntryB;
      stepHandler(e.key === "ArrowRight" ? 1 : -1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    isMixing,
    idleDeck,
    idleSnapshot.track,
    handleStepEntryA,
    handleStepEntryB,
  ]);

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

  // A deck we just mixed away from is done: empty it so the DJ picks what goes there next
  // (the queue head is staged straight away if there is one).
  const retireDeck = useCallback(
    (deck: DeckId) => {
      djEngine.unloadTrack(deck);
      stageNextFromQueue(deck);
    },
    [stageNextFromQueue],
  );

  // Every finished mix (Fade to, auto-play or a hand mix on the fader) retires the old deck.
  useEffect(() => {
    djEngine.setOnMixComplete((oldDeck) => {
      autoFadeTriggeredForRef.current = null;
      autoPickTriggeredForRef.current = null;
      retireDeck(oldDeck);
    });
    return () => djEngine.setOnMixComplete(null);
  }, [retireDeck]);

  // Dead-air recovery: if the live song ever reaches `ended` while Auto-Play is ON
  // (e.g. very short track, manual scrub near end, or toggled on late), immediately
  // start the staged deck or auto-pick the next close-BPM track so the room never goes silent.
  useEffect(() => {
    djEngine.setOnDeckEnded((endedDeck) => {
      const autoPlay = autoPlayRef.current;
      const otherHasTrack = djEngine.getDeck(endedDeck === "A" ? "B" : "A").track !== null;
      // Without Auto-Play, a loaded next deck or a queue means the DJ has decided — respect it.
      // Only an empty next deck and an empty queue fall through to the library safety net.
      if (!autoPlay && (otherHasTrack || queueRef.current.length > 0)) return;
      autoFadeTriggeredForRef.current = null;
      autoPickTriggeredForRef.current = null;

      const otherDeck: DeckId = endedDeck === "A" ? "B" : "A";
      const otherSnap = djEngine.getDeck(otherDeck);
      const endedSnap = djEngine.getDeck(endedDeck);

      if (otherSnap.track) {
        djEngine.setCrossfade(otherDeck === "A" ? 0 : 1, false);
        void djEngine.play(otherDeck).then((ok) => {
          if (ok) {
            retireDeck(endedDeck);
          } else {
            toast.error(`Could not play “${otherSnap.track?.title ?? "next track"}”.`);
          }
        });
        return;
      }

      const currentQ = queueRef.current;
      if (currentQ.length > 0) {
        const [first, ...rest] = currentQ;
        if (first) {
          setQueue(rest);
          djEngine.setCrossfade(otherDeck === "A" ? 0 : 1, false);
          djEngine.unloadTrack(endedDeck);
          void djEngine.loadTrack(otherDeck, first.track);
          void djEngine.play(otherDeck);
          flashDeck(otherDeck);
          toast.info(`Auto-playing “${first.track.title}”`);
          return;
        }
      }

      const allTracks = tracksRef.current;
      if (allTracks.length > 1) {
        const excludeIds = new Set<string>();
        if (endedSnap.track) excludeIds.add(endedSnap.track.id);
        const picked = pickAutoNextTrack(allTracks, {
          referenceBpm: endedSnap.bpm ?? endedSnap.track?.bpm ?? null,
          referenceKey: endedSnap.cues?.key ?? null,
          playedIds: playedIdsRef.current,
          excludeIds,
        });
        if (picked) {
          djEngine.setCrossfade(otherDeck === "A" ? 0 : 1, false);
          djEngine.unloadTrack(endedDeck);
          void djEngine.loadTrack(otherDeck, picked);
          void djEngine.play(otherDeck);
          flashDeck(otherDeck);
          toast.info(`Nothing queued — auto-playing “${picked.title}” from the library`);
        }
      }
    });

    return () => {
      djEngine.setOnDeckEnded(null);
    };
  }, [flashDeck, retireDeck]);

  // Once the mix lands on the other deck, the deck that was live before is spent: eject it
  // (playing or stopped) so the fader can never bring the previous song back. Only the
  // previously-live deck qualifies — an incoming deck that just started is never touched.
  const previousLiveRef = useRef<DeckId | null>(null);
  useEffect(() => {
    if (!liveDeck || isMixing) return;
    const previous = previousLiveRef.current;
    previousLiveRef.current = liveDeck;
    if (previous && previous !== liveDeck && isDeckFadedOut(previous, crossfade)) {
      if (djEngine.getDeck(previous).track) retireDeck(previous);
    } else if (previous && previous !== liveDeck) {
      // Fader still partly open on the old deck: remember it until it is fully out.
      previousLiveRef.current = previous;
    }
  }, [liveDeck, isMixing, crossfade, retireDeck]);

  // Auto-stage first queued track into the idle deck if idle deck is empty
  useEffect(() => {
    if (!idleSnapshot.track && queue.length > 0 && !isMixing) {
      stageNextFromQueue(idleDeck);
    }
  }, [idleSnapshot.track, queue.length, idleDeck, isMixing, stageNextFromQueue]);

  // Auto-Play safety net:
  // 1) If queue & idle deck are empty ahead of the live deck's mix-out flag, auto-pick
  //    a random unplayed cached track with a close BPM and stage it on the idle deck.
  // 2) Trigger auto-mix at `exitFlag.sec - lead` so startAutoFade lands cleanly on beat 1.
  useEffect(() => {
    if (!autoPlayEnabled || mixOutSkipped || isMixing || !liveDeck || !liveSnapshot?.track) return;

    const plannedFadeSec = upcomingTransitionPlan
      ? upcomingTransitionPlan.durationMs / 1000
      : barFadeDurationMs(liveSnapshot.bpm, fadeBars) / 1000;

    let timeToMix: number;
    let triggerKey: string;
    let minTriggerWindow: number;

    if (liveExitSpot) {
      timeToMix = liveExitSpot.sec - liveSnapshot.currentTime;
      triggerKey = `${liveDeck}:${liveSnapshot.track.id}:${liveExitSpot.bar}`;
      minTriggerWindow = -0.25;
    } else {
      const triggerLeadSec = plannedFadeSec + FALLBACK_AUTO_FADE_LEAD_BUFFER_SEC;
      if (liveSnapshot.duration <= triggerLeadSec + 2) return;
      timeToMix = liveSnapshot.duration - triggerLeadSec - liveSnapshot.currentTime;
      triggerKey = `${liveDeck}:${liveSnapshot.track.id}:fallback`;
      minTriggerWindow = -(plannedFadeSec - 0.5);
    }

    // Pre-stage a close-BPM random track ~10s before the mix-out flag if nothing is queued
    if (
      !idleSnapshot.track &&
      queue.length === 0 &&
      tracks.length > 1 &&
      timeToMix <= 10 &&
      autoPickTriggeredForRef.current !== triggerKey
    ) {
      const excludeIds = new Set<string>();
      if (deckA.track) excludeIds.add(deckA.track.id);
      if (deckB.track) excludeIds.add(deckB.track.id);

      const picked = pickAutoNextTrack(tracks, {
        referenceBpm: liveSnapshot.bpm ?? liveSnapshot.track.bpm,
        referenceKey: liveSnapshot.cues?.key ?? null,
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
      timeToMix <= AUTO_MIX_FLAG_LEAD_SEC &&
      timeToMix > minTriggerWindow &&
      idleSnapshot.track &&
      autoFadeTriggeredForRef.current !== triggerKey
    ) {
      autoFadeTriggeredForRef.current = triggerKey;
      const targetTitle = idleSnapshot.track.title;
      const moveLabel = upcomingTransitionPlan ? ` (${upcomingTransitionPlan.label})` : "";
      toast.info(`Auto-fading to ${targetTitle}${moveLabel}`);
      void djEngine
        .startAutoFade(idleDeck)
        .then((ok) => {
          if (!ok) {
            autoFadeTriggeredForRef.current = null;
            toast.error(`Could not play “${targetTitle}” — skipping to next`);
            stageNextFromQueue(idleDeck);
          }
        });
    }
  }, [
    autoPlayEnabled,
    mixOutSkipped,
    isMixing,
    liveDeck,
    liveSnapshot,
    liveExitSpot,
    idleDeck,
    idleSnapshot.track,
    deckA.track,
    deckB.track,
    queue.length,
    tracks,
    playedIds,
    fadeBars,
    mixMode,
    upcomingTransitionPlan,
    flashDeck,
    stageNextFromQueue,
    retireDeck,
  ]);

  const applyLoadedTracks = useCallback((name: string, loaded: TrackItem[]) => {
    const seq = ++folderLoadSeqRef.current;
    setTracks(loaded);
    hydratingRef.current.clear();
    metaQueueRef.current = [];
    autoFadeTriggeredForRef.current = null;
    autoPickTriggeredForRef.current = null;
    analysisScheduler.reset();

    if (loaded.length === 0) {
      toast.error("No supported audio files found in that folder.");
      return;
    }

    toast.success(`Loaded ${loaded.length} songs from ${name}`);

    // Batch-restore all cached titles, covers, BPMs, and transition cues in one IndexedDB read,
    // then trickle-analyze remaining tracks in a Web Worker in the background
    void hydrateCachedLibrary(loaded).then((hydrated) => {
      if (folderLoadSeqRef.current !== seq) return;
      setTracks(hydrated);
      analysisScheduler.enqueueMany(hydrated, "low");
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
      if (isMixing) {
        toast.info("Wait for the current fade to finish before loading a deck.");
        return;
      }

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
        void djEngine.play("A").then((ok) => {
          if (!ok) {
            toast.error(`Could not play “${track.title}”.`);
          }
        });
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
    [deckA.track, deckB.track, flashDeck, idleDeck, isMixing, liveDeck, playedIds],
  );

  const handleDropTrack = useCallback(
    (deck: DeckId, trackId: string) => {
      const track = tracksRef.current.find((t) => t.id === trackId);
      if (!track) return;
      if (deck !== idleDeck) {
        toast.error("Cannot overwrite the ON AIR deck while it is playing.");
        return;
      }
      handleLoadNext(track);
    },
    [handleLoadNext, idleDeck],
  );
  const handleDropTrackA = useCallback((id: string) => handleDropTrack("A", id), [handleDropTrack]);
  const handleDropTrackB = useCallback((id: string) => handleDropTrack("B", id), [handleDropTrack]);

  const ensureTrackAnalysis = useCallback((track: TrackItem) => {
    analysisScheduler.enqueue(track, "queued");
  }, []);

  const handlePrioritizeBpm = useCallback(
    (selected: TrackItem, neighbors: TrackItem[]) => {
      analysisScheduler.setFocusWindow(selected, neighbors);
    },
    [],
  );

  const handleScrollActivity = useCallback(() => {
    analysisScheduler.notifyScrollActivity(220);
  }, []);

  const handleAddToQueue = useCallback(
    (track: TrackItem, force = false, insertAt?: number) => {
      if (queueRef.current.some((entry) => entry.track.id === track.id)) {
        toast.info(`“${track.title}” is already in the queue`);
        return;
      }

      if (liveSnapshot?.track?.id === track.id) {
        toast.info(`“${track.title}” is currently playing on Deck ${liveDeck}`);
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
            onClick: () => handleAddToQueue(track, true, insertAt),
          },
        });
        return;
      }

      if (!deckA.track && !deckB.track && !isMixing) {
        djEngine.setCrossfade(0, false);
        void djEngine.loadTrack("A", track);
        flashDeck("A");
        toast.success(`Loaded “${track.title}” onto Deck A`);
        return;
      }
      if (!idleSnapshot.track && !isMixing) {
        void djEngine.loadTrack(idleDeck, track);
        flashDeck(idleDeck);
        toast.success(`Staged “${track.title}” on Deck ${idleDeck} (Up Next)`);
        return;
      }
      const uid = `q-${++queueSeqRef.current}-${track.id}`;
      setQueue((prev) => {
        const at = insertAt === undefined ? prev.length : Math.min(Math.max(0, insertAt), prev.length);
        return [...prev.slice(0, at), { uid, track }, ...prev.slice(at)];
      });
      ensureTrackAnalysis(track);
      toast.success(`Added “${track.title}” to queue`);
    },
    [
      deckA.track,
      deckB.track,
      ensureTrackAnalysis,
      flashDeck,
      idleDeck,
      idleSnapshot.track,
      isMixing,
      liveDeck,
      liveSnapshot?.track?.id,
      playedIds,
    ],
  );

  const handleDropToQueue = useCallback(
    (trackId: string, index: number) => {
      const track = tracksRef.current.find((t) => t.id === trackId);
      if (track) handleAddToQueue(track, false, index);
    },
    [handleAddToQueue],
  );

  const handleAutoFade = useCallback(() => {
    if (isAutoFading) return;
    if (!idleSnapshot.track) {
      toast.error("Load or queue a song for the next deck first.");
      return;
    }
    const targetTitle = idleSnapshot.track.title;
    void djEngine
      .startAutoFade(idleDeck)
      .then((ok) => {
        if (!ok) {
          toast.error(`Could not play “${targetTitle}”. The audio file may be unreadable.`);
        }
      });
  }, [idleDeck, idleSnapshot.track, isAutoFading]);

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
      if (isMixing) {
        toast.info("Wait for the current fade to finish before loading a deck.");
        return;
      }
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
    [queue, idleDeck, isMixing, liveDeck, idleSnapshot.track, flashDeck],
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
      return trackCollator.compare(av, bv);
    });
    return copy;
  }, [tracks, sortMode]);

  const filteredTracks = useMemo(
    () => searchTracks(sortedTracks, query),
    [sortedTracks, query],
  );

  // BPM MATCH always follows the song on air (falls back to the staged deck before anything plays).
  const matchBpm =
    liveSnapshot?.bpm ?? liveSnapshot?.track?.bpm ?? idleSnapshot.bpm ?? idleSnapshot.track?.bpm ?? null;

  // Tracks that mix into the on-air BPM: smooth (green) first, then shift (yellow), closest first.
  const bpmMatchTracks = useMemo(() => {
    if (matchBpm === null) return [];
    const deckIds = new Set([deckA.track?.id, deckB.track?.id]);
    const rank = { good: 0, ok: 1 } as const;
    return tracks
      .filter((t) => t.bpm !== null && !deckIds.has(t.id) && !playedIds.has(t.id))
      .map((t) => ({ track: t, fit: evaluateBpmFit(matchBpm, t.bpm) }))
      .flatMap((m) =>
        m.fit.status === "good" || m.fit.status === "ok"
          ? [{ ...m, rank: rank[m.fit.status] }]
          : [],
      )
      .sort((a, b) => a.rank - b.rank || Math.abs(a.fit.diffBpm) - Math.abs(b.fit.diffBpm))
      .slice(0, BPM_MATCH_LIMIT)
      .map((m) => m.track);
  }, [tracks, matchBpm, deckA.track?.id, deckB.track?.id, playedIds]);

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
              keyFit={idleDeck === "A" ? nextKeyFit : null}
              audibility={audibilityA}
              isEndingSoon={isAEndingSoon}
              loadFlashKey={loadFlashA}
              cueSpots={liveDeck === "A" ? deckA.cues?.exits : deckA.cues?.entries}
              flagSec={liveDeck === "A" ? (exitSpotA?.sec ?? null) : (entrySpotA?.sec ?? null)}
              canStepEntryPrev={canStepPrevA}
              canStepEntryNext={canStepNextA}
              onStepEntry={liveDeck === "A" ? undefined : handleStepEntryA}
              onPlay={handlePlayA}
              onSoftStop={handleSoftStopA}
              onSeek={handleSeekA}
              onToggleLock={handleToggleLockA}
              onDropTrack={liveDeck === "A" ? undefined : handleDropTrackA}
            />
            <CrossfaderPanel
              crossfade={crossfade}
              isAutoFading={isAutoFading}
              fadeBars={fadeBars}
              mixMode={mixMode}
              transitionLabel={transitionBadgeLabel}
              nextBeatQuality={nextBeatQuality}
              mixOutSkipped={mixOutSkipped}
              onToggleMixOut={
                autoPlayEnabled && liveSnapshot?.isPlaying && !isAutoFading
                  ? handleToggleMixOut
                  : undefined
              }
              nextDeck={idleDeck}
              canAutoFade={Boolean(idleSnapshot.track)}
              onCrossfadeChange={handleCrossfadeChange}
              onAutoFade={handleAutoFade}
              onFadeBarsChange={setFadeBars}
              onMixModeChange={setMixMode}
            />
            <DeckCard
              deckId="B"
              deck={deckB}
              isLive={liveDeck === "B"}
              keyFit={idleDeck === "B" ? nextKeyFit : null}
              audibility={audibilityB}
              isEndingSoon={isBEndingSoon}
              loadFlashKey={loadFlashB}
              cueSpots={liveDeck === "B" ? deckB.cues?.exits : deckB.cues?.entries}
              flagSec={liveDeck === "B" ? (exitSpotB?.sec ?? null) : (entrySpotB?.sec ?? null)}
              canStepEntryPrev={canStepPrevB}
              canStepEntryNext={canStepNextB}
              onStepEntry={liveDeck === "B" ? undefined : handleStepEntryB}
              onPlay={handlePlayB}
              onSoftStop={handleSoftStopB}
              onSeek={handleSeekB}
              onToggleLock={handleToggleLockB}
              onDropTrack={liveDeck === "B" ? undefined : handleDropTrackB}
            />
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[1.65fr_1fr]">
            <LibraryPanel
              tracks={filteredTracks}
              matchTracks={bpmMatchTracks}
              matchBpm={matchBpm}
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
              onRemoveAt={handleRemoveQueueAt}
              onMove={handleMoveQueue}
              onClear={handleClearQueue}
              onDropTrack={handleDropToQueue}
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
                  keyFit={idleDeck === "A" ? nextKeyFit : null}
                  audibility={audibilityA}
                  isEndingSoon={isAEndingSoon}
                  loadFlashKey={loadFlashA}
                  cueSpots={liveDeck === "A" ? deckA.cues?.exits : deckA.cues?.entries}
                  flagSec={liveDeck === "A" ? (exitSpotA?.sec ?? null) : (entrySpotA?.sec ?? null)}
                  canStepEntryPrev={canStepPrevA}
              canStepEntryNext={canStepNextA}
                  onStepEntry={liveDeck === "A" ? undefined : handleStepEntryA}
                  onPlay={handlePlayA}
                  onSoftStop={handleSoftStopA}
                  onSeek={handleSeekA}
                  onToggleLock={handleToggleLockA}
                />
                <CrossfaderPanel
                  crossfade={crossfade}
                  isAutoFading={isAutoFading}
                  fadeBars={fadeBars}
                  mixMode={mixMode}
                  transitionLabel={transitionBadgeLabel}
                  nextBeatQuality={nextBeatQuality}
              mixOutSkipped={mixOutSkipped}
              onToggleMixOut={
                autoPlayEnabled && liveSnapshot?.isPlaying && !isAutoFading
                  ? handleToggleMixOut
                  : undefined
              }
                  nextDeck={idleDeck}
                  canAutoFade={Boolean(idleSnapshot.track)}
                  onCrossfadeChange={handleCrossfadeChange}
                  onAutoFade={handleAutoFade}
                  onFadeBarsChange={setFadeBars}
                  onMixModeChange={setMixMode}
                />
                <DeckCard
                  deckId="B"
                  deck={deckB}
                  isLive={liveDeck === "B"}
                  keyFit={idleDeck === "B" ? nextKeyFit : null}
                  audibility={audibilityB}
                  isEndingSoon={isBEndingSoon}
                  loadFlashKey={loadFlashB}
                  cueSpots={liveDeck === "B" ? deckB.cues?.exits : deckB.cues?.entries}
                  flagSec={liveDeck === "B" ? (exitSpotB?.sec ?? null) : (entrySpotB?.sec ?? null)}
                  canStepEntryPrev={canStepPrevB}
              canStepEntryNext={canStepNextB}
                  onStepEntry={liveDeck === "B" ? undefined : handleStepEntryB}
                  onPlay={handlePlayB}
                  onSoftStop={handleSoftStopB}
                  onSeek={handleSeekB}
                  onToggleLock={handleToggleLockB}
                />
              </div>
            )}

            {mobileTab === "library" && (
              <LibraryPanel
                tracks={filteredTracks}
                matchTracks={bpmMatchTracks}
              matchBpm={matchBpm}
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
                onRemoveAt={handleRemoveQueueAt}
                onMove={handleMoveQueue}
                onClear={handleClearQueue}
              onDropTrack={handleDropToQueue}
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
