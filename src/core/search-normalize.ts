const GREEK_DIGRAPHS: Array<[RegExp, string]> = [
  [/ου/g, "ou"],
  [/αι/g, "e"],
  [/ει/g, "i"],
  [/οι/g, "i"],
  [/υι/g, "i"],
  [/αυ/g, "av"],
  [/ευ/g, "ev"],
  [/μπ/g, "b"],
  [/ντ/g, "d"],
  [/γκ/g, "g"],
  [/γγ/g, "g"],
  [/τσ/g, "ts"],
  [/τζ/g, "tz"],
];

const GREEK_CHAR_MAP: Record<string, string> = {
  α: "a",
  β: "v",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  θ: "th",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ξ: "ks",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  ς: "s",
  τ: "t",
  υ: "i",
  φ: "f",
  χ: "h",
  ψ: "ps",
  ω: "o",
};

/**
 * Strips accents/diacritics and lowercases text.
 */
export function stripAccents(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Transliterates Greek script to Latin while leaving Latin characters intact.
 */
export function greekToLatin(input: string): string {
  let s = stripAccents(input);
  for (const [re, rep] of GREEK_DIGRAPHS) {
    s = s.replace(re, rep);
  }
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    out += GREEK_CHAR_MAP[ch] ?? ch;
  }
  return out;
}

/**
 * Folds common Greeklish spelling variations into a single phonetic canonical key
 * so "stin igia", "sthn ygeia", "στην υγεία", "axaristis", "aharistis", "αχάριστης"
 * all match each other.
 */
export function toGreeklishCanonical(input: string): string {
  let s = greekToLatin(input);
  // Classic Greeklish digit substitutions when adjacent to letters
  s = s
    .replace(/(?<=[a-z])8|8(?=[a-z])/g, "th")
    .replace(/(?<=[a-z])3|3(?=[a-z])/g, "ks")
    .replace(/(?<=[a-z])4|4(?=[a-z])/g, "ps");

  // Digraph & vowel equivalences
  s = s
    .replace(/ou|oy/g, "u")
    .replace(/ei|oi|ui|yi/g, "i")
    .replace(/ai/g, "e")
    .replace(/mp/g, "b")
    .replace(/nt/g, "d")
    .replace(/gk|gg/g, "g")
    .replace(/ph/g, "f")
    .replace(/ch|kh/g, "h")
    .replace(/ks/g, "x")
    .replace(/y/g, "i")
    .replace(/w/g, "o")
    .replace(/x/g, "h")
    // Collapse double consonants/vowels (e.g., "ellinika" vs "elinika")
    .replace(/([a-z])\1+/g, "$1");

  return s;
}
