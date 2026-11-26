import { get, set } from "idb-keyval";
import { SOUNDBOARD_KEY } from "@/lib/storage-keys";

export interface SoundPad {
  id: string;
  label: string;
  sourceUrl?: string;
  mimeType: string;
  audioData?: ArrayBuffer;
}

export const MAX_SOUND_PADS = 9;

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function extractMyInstantsMeta(html: string): { title: string; mp3Url: string } | null {
  const mp3Match = /\/media\/sounds\/[^"'\s)]+\.(?:mp3|ogg|wav)/i.exec(html);
  if (!mp3Match) return null;
  const titleMatch = /<title>([^<]+)<\/title>/i.exec(html);
  const rawTitle = titleMatch?.[1] ?? "Sound";
  const title = rawTitle
    .replace(/\s*-\s*Instant Sound Effect.*$/i, "")
    .replace(/\s*\|\s*Myinstants.*$/i, "")
    .trim();
  return {
    title: title || "Sound",
    mp3Url: `https://www.myinstants.com${mp3Match[0]}`,
  };
}

export async function loadSoundPads(): Promise<SoundPad[]> {
  try {
    const saved = await get<SoundPad[]>(SOUNDBOARD_KEY);
    return Array.isArray(saved) ? saved.slice(0, MAX_SOUND_PADS) : [];
  } catch {
    return [];
  }
}

export async function saveSoundPads(pads: SoundPad[]): Promise<void> {
  try {
    await set(SOUNDBOARD_KEY, pads.slice(0, MAX_SOUND_PADS));
  } catch {
    // ignore quota errors
  }
}

export async function importFromMyInstants(
  rawUrl: string,
  customLabel?: string,
): Promise<SoundPad> {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Please enter a valid MyInstants URL.");
  }

  if (parsed.hostname !== "www.myinstants.com" && parsed.hostname !== "myinstants.com") {
    throw new Error("URL must be from myinstants.com.");
  }

  // Direct MP3 link pasted
  if (/\/media\/sounds\/.+\.(mp3|ogg|wav)$/i.test(parsed.pathname)) {
    const fallbackName =
      decodeURIComponent(parsed.pathname.split("/").pop() ?? "Sound")
        .replace(/\.(mp3|ogg|wav)$/i, "")
        .replace(/[_-]+/g, " ")
        .trim() || "Sound";
    return {
      id: `pad-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: customLabel?.trim() || fallbackName,
      sourceUrl: parsed.toString(),
      mimeType: "audio/mpeg",
    };
  }

  // 1) In Vite dev mode, use the built-in server proxy for instant offline-cached import
  if (import.meta.env.DEV) {
    const res = await fetch(`/__dev-myinstants?url=${encodeURIComponent(parsed.toString())}`);
    if (res.ok) {
      const data = (await res.json()) as {
        title: string;
        mp3Url: string;
        mimeType: string;
        audioBase64: string;
      };
      return {
        id: `pad-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        label: customLabel?.trim() || data.title,
        sourceUrl: data.mp3Url,
        mimeType: data.mimeType || "audio/mpeg",
        audioData: base64ToArrayBuffer(data.audioBase64),
      };
    }
  }

  // 2) Static GitHub Pages fallback via Jina HTML reader (CORS-enabled) + AllOrigins backup
  const htmlFetchers: Array<() => Promise<Response>> = [
    () =>
      fetch(`https://r.jina.ai/${parsed.toString()}`, {
        headers: { "X-Return-Format": "html" },
        signal: AbortSignal.timeout(8000),
      }),
    () =>
      fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(parsed.toString())}`, {
        signal: AbortSignal.timeout(6000),
      }),
  ];

  let html: string | null = null;
  for (const runFetch of htmlFetchers) {
    try {
      const res = await runFetch();
      if (res.ok) {
        const text = await res.text();
        if (text.includes("/media/sounds/")) {
          html = text;
          break;
        }
      }
    } catch {
      // try next fallback
    }
  }

  if (!html) {
    throw new Error("Could not fetch MyInstants page. Try uploading the MP3 file directly.");
  }

  const meta = extractMyInstantsMeta(html);
  if (!meta) {
    throw new Error("Could not find an audio clip on that MyInstants page.");
  }

  // <audio src="..."> plays cross-origin MP3s directly without CORS headers
  return {
    id: `pad-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label: customLabel?.trim() || meta.title,
    sourceUrl: meta.mp3Url,
    mimeType: "audio/mpeg",
  };
}

export async function importLocalSoundFile(file: File, customLabel?: string): Promise<SoundPad> {
  const audioData = await file.arrayBuffer();
  const baseName = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Sound";
  return {
    id: `pad-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label: customLabel?.trim() || baseName,
    mimeType: file.type || "audio/mpeg",
    audioData,
  };
}

class SoundboardPlayer {
  private audioMap = new Map<string, HTMLAudioElement>();
  private urlMap = new Map<string, string>();

  play(pad: SoundPad, volume = 0.9, onEnd?: () => void): void {
    let audio = this.audioMap.get(pad.id);
    if (!audio) {
      let src = pad.sourceUrl ?? "";
      if (pad.audioData) {
        const blob = new Blob([pad.audioData], { type: pad.mimeType || "audio/mpeg" });
        src = URL.createObjectURL(blob);
        this.urlMap.set(pad.id, src);
      }
      if (!src) return;
      audio = new Audio(src);
      audio.preload = "auto";
      this.audioMap.set(pad.id, audio);
    }

    audio.volume = Math.min(1, Math.max(0, volume));
    audio.currentTime = 0;
    audio.onended = () => onEnd?.();
    audio.onerror = () => onEnd?.();
    void audio.play().catch(() => {
      onEnd?.();
    });
  }

  dispose(padId: string): void {
    const audio = this.audioMap.get(padId);
    if (audio) {
      audio.pause();
      this.audioMap.delete(padId);
    }
    const objUrl = this.urlMap.get(padId);
    if (objUrl) {
      URL.revokeObjectURL(objUrl);
      this.urlMap.delete(padId);
    }
  }
}

export const soundboardPlayer = new SoundboardPlayer();
