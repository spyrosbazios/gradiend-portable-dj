import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import {
  DEFAULT_THEME,
  THEMES,
  pageTheme,
  withAccent,
  type AccentName,
  type ThemeName,
} from "@/core/theme";
import { PREFS_KEY } from "@/lib/storage-keys";

interface ThemePrefs {
  theme: ThemeName;
  accent: AccentName;
}

interface ThemeContextValue extends ThemePrefs {
  setTheme: (theme: ThemeName) => void;
  setAccent: (accent: AccentName) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readPrefs(): ThemePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { theme: DEFAULT_THEME, accent: "theme" };
    const parsed = JSON.parse(raw) as Partial<ThemePrefs>;
    const theme: ThemeName =
      parsed.theme && parsed.theme in THEMES ? parsed.theme : DEFAULT_THEME;
    const accent: AccentName = parsed.accent ?? "theme";
    return { theme, accent };
  } catch {
    return { theme: DEFAULT_THEME, accent: "theme" };
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<ThemePrefs>(readPrefs);

  const setTheme = (theme: ThemeName) => {
    setPrefs((prev) => {
      const next = { ...prev, theme };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const setAccent = (accent: AccentName) => {
    setPrefs((prev) => {
      const next = { ...prev, accent };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  useLayoutEffect(() => {
    const resolved = pageTheme(withAccent(THEMES[prefs.theme], prefs.accent));
    const root = document.documentElement;
    for (const [k, v] of Object.entries(resolved.vars)) {
      root.style.setProperty(`--app-${k}`, v);
    }
    root.style.colorScheme = resolved.scheme;
    root.classList.toggle("dark", resolved.scheme === "dark");
    root.dataset.scheme = resolved.scheme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", resolved.vars.bg ?? "");
  }, [prefs.theme, prefs.accent]);

  return (
    <ThemeContext.Provider value={{ ...prefs, setTheme, setAccent }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
