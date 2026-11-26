import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const AUDIO_EXT_RE = /\.(mp3|m4a|wav|flac|ogg|aac|opus|webm)$/i;

const MIME_MAP: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg; codecs=opus",
  ".aac": "audio/aac",
  ".webm": "audio/webm",
};

interface DevMusicEntry {
  relPath: string;
  filename: string;
  size: number;
  lastModified: number;
}

function scanAudioFiles(rootDir: string, dir = rootDir, out: DevMusicEntry[] = []): DevMusicEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanAudioFiles(rootDir, full, out);
    } else if (entry.isFile() && AUDIO_EXT_RE.test(entry.name)) {
      try {
        const stat = fs.statSync(full);
        out.push({
          relPath: path.relative(rootDir, full),
          filename: entry.name,
          size: stat.size,
          lastModified: Math.floor(stat.mtimeMs),
        });
      } catch {
        // skip unreadable files
      }
    }
  }
  return out;
}

export function devMusicPlugin(musicDir: string) {
  const resolvedRoot = path.resolve(musicDir);

  return {
    name: "dev-music-plugin",
    configureServer(server: {
      middlewares: {
        use: (
          fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void,
        ) => void;
      };
    }) {
      server.middlewares.use((req, res, next) => {
        const reqUrl = req.url ?? "";
        if (reqUrl === "/__dev-music/list") {
          if (!fs.existsSync(resolvedRoot)) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Music directory not found", dir: resolvedRoot }));
            return;
          }
          const tracks = scanAudioFiles(resolvedRoot);
          tracks.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: "base" }));
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              folderName: path.basename(resolvedRoot),
              tracks,
            }),
          );
          return;
        }

        if (reqUrl.startsWith("/__dev-myinstants")) {
          void (async () => {
            try {
              const parsed = new URL(reqUrl, "http://localhost");
              const rawTarget = parsed.searchParams.get("url") ?? "";
              const targetUrl = new URL(rawTarget);
              if (
                targetUrl.hostname !== "www.myinstants.com" &&
                targetUrl.hostname !== "myinstants.com"
              ) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Only myinstants.com URLs are supported" }));
                return;
              }

              const pageRes = await fetch(targetUrl.toString(), {
                headers: { "User-Agent": "Mozilla/5.0" },
              });
              if (!pageRes.ok) {
                res.statusCode = 502;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: `Failed to fetch page (${pageRes.status})` }));
                return;
              }

              const html = await pageRes.text();
              const mp3Match = /\/media\/sounds\/[^"'\s)]+\.(?:mp3|ogg|wav)/i.exec(html);
              if (!mp3Match) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "No sound file found on that MyInstants page" }));
                return;
              }

              const titleMatch = /<title>([^<]+)<\/title>/i.exec(html);
              const rawTitle = titleMatch?.[1] ?? "Sound";
              const title = rawTitle
                .replace(/\s*-\s*Instant Sound Effect.*$/i, "")
                .replace(/\s*\|\s*Myinstants.*$/i, "")
                .trim();

              const mp3Url = `https://www.myinstants.com${mp3Match[0]}`;
              const audioRes = await fetch(mp3Url, {
                headers: { "User-Agent": "Mozilla/5.0" },
              });
              if (!audioRes.ok) {
                res.statusCode = 502;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Failed to download sound audio" }));
                return;
              }

              const buf = Buffer.from(await audioRes.arrayBuffer());
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  title: title || "Sound",
                  mp3Url,
                  mimeType: audioRes.headers.get("content-type") || "audio/mpeg",
                  audioBase64: buf.toString("base64"),
                }),
              );
            } catch {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Could not import MyInstants link" }));
            }
          })();
          return;
        }

        if (reqUrl.startsWith("/__dev-music/file")) {
          const parsed = new URL(reqUrl, "http://localhost");
          const rel = parsed.searchParams.get("path") ?? "";
          const fullPath = path.resolve(resolvedRoot, rel);
          if (!fullPath.startsWith(resolvedRoot + path.sep) || !fs.existsSync(fullPath)) {
            res.statusCode = 404;
            res.end("Not found");
            return;
          }

          const stat = fs.statSync(fullPath);
          const ext = path.extname(fullPath).toLowerCase();
          const contentType = MIME_MAP[ext] ?? "application/octet-stream";
          const range = req.headers.range;

          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Content-Type", contentType);

          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            const start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
            const end = match?.[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
            const clampedEnd = Math.min(end, stat.size - 1);
            if (start >= stat.size || start > clampedEnd) {
              res.statusCode = 416;
              res.setHeader("Content-Range", `bytes */${stat.size}`);
              res.end();
              return;
            }
            res.statusCode = 206;
            res.setHeader("Content-Range", `bytes ${start}-${clampedEnd}/${stat.size}`);
            res.setHeader("Content-Length", String(clampedEnd - start + 1));
            fs.createReadStream(fullPath, { start, end: clampedEnd }).pipe(res);
          } else {
            res.statusCode = 200;
            res.setHeader("Content-Length", String(stat.size));
            fs.createReadStream(fullPath).pipe(res);
          }
          return;
        }

        next();
      });
    },
  };
}
