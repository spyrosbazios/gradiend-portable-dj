import uFuzzy from "@leeoniya/ufuzzy";
import { greekToLatin, stripAccents, toGreeklishCanonical } from "@/core/search-normalize";
import type { TrackItem } from "@/lib/audio-engine";

const fuzzy = new uFuzzy({
  intraMode: 1,
  intraIns: 1,
});

interface PreparedTrack {
  rawTitle: string;
  rawArtist: string;
  rawAll: string;
  canonTitle: string;
  canonArtist: string;
  canonAll: string;
}

const preparedCache = new WeakMap<TrackItem, PreparedTrack>();

function getPrepared(track: TrackItem): PreparedTrack {
  const cached = preparedCache.get(track);
  if (cached) return cached;

  const rawTitle = greekToLatin(track.title);
  const rawArtist = greekToLatin(track.artist);
  const rawFile = greekToLatin(track.filename);
  const canonTitle = toGreeklishCanonical(track.title);
  const canonArtist = toGreeklishCanonical(track.artist);
  const canonFile = toGreeklishCanonical(track.filename);

  const entry: PreparedTrack = {
    rawTitle,
    rawArtist,
    rawAll: `${rawTitle} ${rawArtist} ${rawFile}`,
    canonTitle,
    canonArtist,
    canonAll: `${canonTitle} ${canonArtist} ${canonFile}`,
  };
  preparedCache.set(track, entry);
  return entry;
}

function scoreTokenMatch(haystack: string, token: string): number {
  const idx = haystack.indexOf(token);
  if (idx === -1) return 0;
  if (idx === 0) return 4;
  const prev = haystack[idx - 1];
  if (prev === " " || prev === "-" || prev === "(" || prev === "_") return 3;
  return 2; // mid-word match
}

export function searchTracks(tracks: TrackItem[], query: string): TrackItem[] {
  const trimmed = query.trim();
  if (!trimmed) return tracks;

  const rawTokens = stripAccents(greekToLatin(trimmed)).split(/\s+/).filter(Boolean);
  const canonTokens = rawTokens.map(toGreeklishCanonical);

  const scored: Array<{ track: TrackItem; score: number }> = [];

  for (const track of tracks) {
    const p = getPrepared(track);
    let totalScore = 0;
    let allMatched = true;

    for (let i = 0; i < rawTokens.length; i++) {
      const rTok = rawTokens[i]!;
      const cTok = canonTokens[i]!;

      const titleScore = Math.max(
        scoreTokenMatch(p.rawTitle, rTok),
        scoreTokenMatch(p.canonTitle, cTok),
      );
      const artistScore = Math.max(
        scoreTokenMatch(p.rawArtist, rTok),
        scoreTokenMatch(p.canonArtist, cTok),
      );
      const anyScore = Math.max(
        titleScore * 2,
        artistScore * 1.6,
        scoreTokenMatch(p.rawAll, rTok),
        scoreTokenMatch(p.canonAll, cTok),
      );

      if (anyScore === 0) {
        allMatched = false;
        break;
      }
      totalScore += anyScore;
    }

    if (allMatched) {
      scored.push({ track, score: totalScore });
    }
  }

  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.track);
  }

  // Typo-tolerant fallback with uFuzzy over Greeklish-canonical haystacks
  const canonQuery = toGreeklishCanonical(trimmed);
  const haystack = tracks.map((t) => getPrepared(t).canonAll);
  const idxs = fuzzy.filter(haystack, canonQuery);
  if (!idxs || idxs.length === 0) return [];

  if (idxs.length <= 200) {
    const info = fuzzy.info(idxs, haystack, canonQuery);
    const order = fuzzy.sort(info, haystack, canonQuery);
    return order.map((i) => tracks[info.idx[i]!]!).filter(Boolean);
  }

  return idxs.map((i) => tracks[i]!).filter(Boolean);
}
