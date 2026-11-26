import { get, getMany, set } from "idb-keyval";
import { parseBlob } from "music-metadata";
import { isAudioFile, parseFilenameMetadata } from "@/core/dj-math";
import type { TrackItem } from "@/lib/audio-engine";
import { FOLDER_HANDLE_KEY, META_CACHE_PREFIX } from "@/lib/storage-keys";

export interface CachedMeta {
  title: string;
  artist: string;
  duration: number | null;
  bpm: number | null;
  coverUrl: string | null;
}

interface DirHandleLike {
  name: string;
  values(): AsyncIterable<FileSystemHandle>;
  queryPermission?: (opts: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: "read" }) => Promise<PermissionState>;
}

export function cacheKeyForTrack(track: TrackItem): string {
  return `${META_CACHE_PREFIX}${track.filename}:${track.size}:${track.lastModified}`;
}

/**
 * Batch-reads all cached metadata, covers, and BPMs in a single IndexedDB transaction.
 */
export async function hydrateCachedLibrary(tracks: TrackItem[]): Promise<TrackItem[]> {
  if (tracks.length === 0) return tracks;
  try {
    const keys = tracks.map(cacheKeyForTrack);
    const cachedList = await getMany<CachedMeta | undefined>(keys);
    return tracks.map((track, i) => {
      const cached = cachedList[i];
      if (!cached) return track;
      return {
        ...track,
        title: cached.title || track.title,
        artist: cached.artist || track.artist,
        duration: cached.duration ?? track.duration,
        bpm: cached.bpm ?? track.bpm,
        coverUrl: cached.coverUrl ?? track.coverUrl,
        metadataLoaded: true,
      };
    });
  } catch {
    return tracks;
  }
}

export function filesToTrackItems(files: File[]): TrackItem[] {
  const audioFiles = files.filter((f) => isAudioFile(f.name));
  audioFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return audioFiles.map((file, idx) => {
    const parsed = parseFilenameMetadata(file.name);
    return {
      id: `${file.name}:${file.size}:${file.lastModified}:${idx}`,
      file,
      size: file.size,
      lastModified: file.lastModified,
      filename: file.name,
      title: parsed.title,
      artist: parsed.artist,
      duration: null,
      bpm: null,
      coverUrl: null,
      metadataLoaded: false,
    };
  });
}

const IGNORED_DIRS = new Set([
  "System Volume Information",
  "$RECYCLE.BIN",
  ".Spotlight-V100",
  ".Trashes",
  ".fseventsd",
  "__MACOSX",
]);

async function collectFilesFromDirectory(dirHandle: DirHandleLike): Promise<File[]> {
  const results: File[] = [];
  try {
    for await (const entry of dirHandle.values()) {
      const name = entry.name ?? "";
      if (!name || name.startsWith(".") || IGNORED_DIRS.has(name)) continue;

      if (entry.kind === "file") {
        // Check extension BEFORE opening file handle to skip images/PDFs/system files on USB
        if (!isAudioFile(name)) continue;
        try {
          const fileHandle = entry as FileSystemFileHandle;
          const file = await fileHandle.getFile();
          if (file.size > 0) results.push(file);
        } catch {
          // Skip unreadable or locked file without aborting the rest of the library
        }
      } else if (entry.kind === "directory") {
        try {
          const sub = await collectFilesFromDirectory(entry as unknown as DirHandleLike);
          results.push(...sub);
        } catch {
          // Skip unreadable subdirectories (e.g. OS-protected folders on FAT32/exFAT)
        }
      }
    }
  } catch {
    // Return whatever was collected if directory enumeration fails partway
  }
  return results;
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function pickDirectoryTracks(): Promise<{ folderName: string; tracks: TrackItem[] } | null> {
  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<DirHandleLike> }).showDirectoryPicker;
  if (!picker) return null;

  const dirHandle = await picker();
  try {
    await set(FOLDER_HANDLE_KEY, dirHandle);
  } catch {
    // IndexedDB persistence is best-effort
  }
  const files = await collectFilesFromDirectory(dirHandle);
  return { folderName: dirHandle.name, tracks: filesToTrackItems(files) };
}

export async function getSavedFolderName(): Promise<string | null> {
  try {
    const handle = await get<DirHandleLike>(FOLDER_HANDLE_KEY);
    return handle?.name ?? null;
  } catch {
    return null;
  }
}

export async function reconnectSavedFolder(): Promise<{ folderName: string; tracks: TrackItem[] } | null> {
  const handle = await get<DirHandleLike>(FOLDER_HANDLE_KEY);
  if (!handle) return null;

  if (handle.queryPermission && handle.requestPermission) {
    let perm = await handle.queryPermission({ mode: "read" });
    if (perm !== "granted") {
      perm = await handle.requestPermission({ mode: "read" });
    }
    if (perm !== "granted") return null;
  }

  const files = await collectFilesFromDirectory(handle);
  return { folderName: handle.name, tracks: filesToTrackItems(files) };
}

async function resizeCoverToDataUrl(data: Uint8Array, format: string): Promise<string | null> {
  try {
    const blob = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], {
      type: format || "image/jpeg",
    });
    const bitmap = await createImageBitmap(blob);
    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  }
}

export async function hydrateTrackMetadata(track: TrackItem): Promise<Partial<TrackItem>> {
  const key = cacheKeyForTrack(track);
  try {
    const cached = await get<CachedMeta>(key);
    if (cached) {
      return {
        title: cached.title,
        artist: cached.artist,
        duration: cached.duration,
        bpm: cached.bpm ?? null,
        coverUrl: cached.coverUrl,
        metadataLoaded: true,
      };
    }
  } catch {
    // ignore cache errors
  }

  try {
    const blob = track.file
      ? track.file
      : track.remoteUrl
        ? await fetch(track.remoteUrl).then((r) => r.blob())
        : null;
    if (!blob) return { metadataLoaded: true };

    const meta = await parseBlob(blob, { skipPostHeaders: true });
    const title = meta.common.title?.trim() || track.title;
    const artist = meta.common.artist?.trim() || track.artist;
    const duration = meta.format.duration ?? null;
    const rawBpm = meta.common.bpm;
    const bpm =
      typeof rawBpm === "number" && Number.isFinite(rawBpm) && rawBpm > 30 && rawBpm < 300
        ? Math.round(rawBpm)
        : null;
    let coverUrl: string | null = null;
    const pic = meta.common.picture?.[0];
    if (pic) {
      coverUrl = await resizeCoverToDataUrl(pic.data, pic.format);
    }

    const toCache: CachedMeta = { title, artist, duration, bpm, coverUrl };
    try {
      await set(key, toCache);
    } catch {
      // ignore quota errors
    }

    return { ...toCache, metadataLoaded: true };
  } catch {
    return { metadataLoaded: true };
  }
}
