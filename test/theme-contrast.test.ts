import { describe, expect, test } from "bun:test";
import { contrastRatio, THEMES } from "@/core/theme";

describe("theme accessibility (WCAG AA 4.5:1)", () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    test(`${name} meets AA contrast for primary text and status roles on bg`, () => {
      const roles = ["fg", "dim", "brand", "up", "down", "warn", "deckA", "deckB"] as const;
      for (const role of roles) {
        const ratio = contrastRatio(theme.C[role], theme.C.bg);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
