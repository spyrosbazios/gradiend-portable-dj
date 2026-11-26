export type ThemeName = "dark" | "oled" | "light";
export type AccentName = "theme" | "cyan" | "amber" | "violet" | "emerald" | "rose";

export type Palette = {
  bg: string;
  card: string;
  raised: string;
  line: string;
  fg: string;
  dim: string;
  faint: string;
  brand: string;
  up: string;
  down: string;
  warn: string;
  deckA: string;
  deckB: string;
};

export type Tints = {
  muted: string;
  accent: string;
  "brand-soft": string;
  "brand-line": string;
  "up-soft": string;
  "up-subtle": string;
  "down-soft": string;
  "down-subtle": string;
  "warn-soft": string;
  "warn-subtle": string;
  "deckA-soft": string;
  "deckA-line": string;
  "deckB-soft": string;
  "deckB-line": string;
  scrim: string;
};

export type Theme = {
  name: ThemeName;
  label: string;
  scheme: "light" | "dark";
  C: Palette;
  TINT: Tints;
};

function channels(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const n = Number.parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function alpha(hex: string, a: number): string {
  return `rgba(${channels(hex).join(", ")}, ${a})`;
}

function tints(C: Palette): Tints {
  return {
    muted: alpha(C.fg, 0.07),
    accent: alpha(C.brand, 0.14),
    "brand-soft": alpha(C.brand, 0.1),
    "brand-line": alpha(C.brand, 0.28),
    "up-soft": alpha(C.up, 0.1),
    "up-subtle": alpha(C.up, 0.22),
    "down-soft": alpha(C.down, 0.08),
    "down-subtle": alpha(C.down, 0.2),
    "warn-soft": alpha(C.warn, 0.1),
    "warn-subtle": alpha(C.warn, 0.24),
    "deckA-soft": alpha(C.deckA, 0.11),
    "deckA-line": alpha(C.deckA, 0.34),
    "deckB-soft": alpha(C.deckB, 0.11),
    "deckB-line": alpha(C.deckB, 0.34),
    scrim: alpha("#000000", 0.55),
  };
}

function makeTheme(name: ThemeName, label: string, scheme: "light" | "dark", C: Palette): Theme {
  return { name, label, scheme, C, TINT: tints(C) };
}

export const THEMES: Record<ThemeName, Theme> = {
  dark: makeTheme("dark", "Studio Dark", "dark", {
    bg: "#0e1015",
    card: "#151922",
    raised: "#1d222e",
    line: "#2b3242",
    fg: "#e8ecf4",
    dim: "#9aa5b8",
    faint: "#6e7a90",
    brand: "#67d5f7",
    up: "#4ade80",
    down: "#f87171",
    warn: "#fbbf24",
    deckA: "#38bdf8",
    deckB: "#fb923c",
  }),
  oled: makeTheme("oled", "OLED Black", "dark", {
    bg: "#000000",
    card: "#0d0f14",
    raised: "#161a23",
    line: "#262c3a",
    fg: "#eaeef6",
    dim: "#9ca7ba",
    faint: "#6e7a90",
    brand: "#67d5f7",
    up: "#4ade80",
    down: "#f87171",
    warn: "#fbbf24",
    deckA: "#38bdf8",
    deckB: "#fb923c",
  }),
  light: makeTheme("light", "Daylight", "light", {
    bg: "#f3f5f8",
    card: "#ffffff",
    raised: "#e8ecf2",
    line: "#cbd3df",
    fg: "#131722",
    dim: "#4b5568",
    faint: "#6b768b",
    brand: "#0369a1",
    up: "#15803d",
    down: "#b91c1c",
    warn: "#b45309",
    deckA: "#0369a1",
    deckB: "#c2410c",
  }),
};

export const DEFAULT_THEME: ThemeName = "dark";

export const ACCENTS: Record<Exclude<AccentName, "theme">, { label: string; dark: string; light: string }> = {
  cyan: { label: "Cyan", dark: "#38bdf8", light: "#0369a1" },
  amber: { label: "Amber", dark: "#fb923c", light: "#c2410c" },
  violet: { label: "Violet", dark: "#a78bfa", light: "#6d28d9" },
  emerald: { label: "Emerald", dark: "#34d399", light: "#047857" },
  rose: { label: "Rose", dark: "#fb7185", light: "#be123c" },
};

const accentCache = new Map<string, Theme>();

export function withAccent(t: Theme, accent: AccentName): Theme {
  if (accent === "theme") return t;
  const key = `${t.name}:${accent}`;
  const cached = accentCache.get(key);
  if (cached) return cached;
  const C: Palette = { ...t.C, brand: ACCENTS[accent][t.scheme] };
  const next: Theme = { ...t, C, TINT: tints(C) };
  accentCache.set(key, next);
  return next;
}

export function themeVars(t: Theme): Record<string, string> {
  return {
    ...t.C,
    ...t.TINT,
  };
}

export function pageTheme(t: Theme): { scheme: "light" | "dark"; vars: Record<string, string> } {
  return { scheme: t.scheme, vars: themeVars(t) };
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
