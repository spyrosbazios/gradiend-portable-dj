import { describe, expect, test } from "bun:test";
import { greekToLatin, toGreeklishCanonical } from "@/core/search-normalize";
import type { TrackItem } from "@/lib/audio-engine";
import { searchTracks } from "@/lib/search";

function makeTrack(id: string, title: string, artist: string): TrackItem {
  return {
    id,
    size: 1000,
    lastModified: 1,
    filename: `${artist} - ${title}.opus`,
    title,
    artist,
    duration: 200,
    bpm: 120,
    cues: null,
    coverUrl: null,
    metadataLoaded: true,
  };
}

describe("Greek & Greeklish normalization", () => {
  test("transliterates Greek script and folds Greeklish variants", () => {
    expect(greekToLatin("Αλέκος Ζαζόπουλος")).toBe("alekos zazopoulos");
    expect(toGreeklishCanonical("Στην υγεία της αχάριστης")).toBe(
      toGreeklishCanonical("stin igia tis axaristis"),
    );
    expect(toGreeklishCanonical("Θάλασσα")).toBe(toGreeklishCanonical("8alasa"));
  });
});

describe("searchTracks (mid-word, Greek, Greeklish, English)", () => {
  const library = [
    makeTrack("1", "Στην υγεία της αχάριστης", "Αλέκος Ζαζόπουλος"),
    makeTrack("2", "Midnight City", "M83"),
    makeTrack("3", "Down In A Hole", "Alice In Chains"),
    makeTrack("4", "Θάλασσα πλατιά", "Νότης Σφακιανάκης"),
    makeTrack("5", "Get Lucky", "Daft Punk"),
  ];

  test("finds Greek songs when typing English/Greeklish", () => {
    expect(searchTracks(library, "zazopoulos").map((t) => t.id)).toEqual(["1"]);
    expect(searchTracks(library, "stin igia").map((t) => t.id)).toEqual(["1"]);
    expect(searchTracks(library, "axaristis").map((t) => t.id)).toEqual(["1"]);
    expect(searchTracks(library, "sfakianakis").map((t) => t.id)).toEqual(["4"]);
    expect(searchTracks(library, "8alassa").map((t) => t.id)).toEqual(["4"]);
  });

  test("matches mid-title and mid-artist substrings", () => {
    expect(searchTracks(library, "zazo").map((t) => t.id)).toEqual(["1"]);
    expect(searchTracks(library, "harist").map((t) => t.id)).toEqual(["1"]);
    expect(searchTracks(library, "night").map((t) => t.id)).toEqual(["2"]);
    expect(searchTracks(library, "hains").map((t) => t.id)).toEqual(["3"]);
    expect(searchTracks(library, "ucky").map((t) => t.id)).toEqual(["5"]);
  });

  test("supports multi-token queries across artist and title", () => {
    expect(searchTracks(library, "alekos ahar").map((t) => t.id)).toEqual(["1"]);
    expect(searchTracks(library, "daft luck").map((t) => t.id)).toEqual(["5"]);
  });
});
