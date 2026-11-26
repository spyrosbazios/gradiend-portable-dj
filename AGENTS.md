# Portable DJ (`gradiend-portable-dj`)

A beginner-friendly, offline-capable PWA DJ console hosted on GitHub Pages that plays local music libraries directly from a USB flash drive.

## Stack (PWA App Blueprint)
- **Runtime & Build:** Bun, Vite, React 19, TypeScript (strict)
- **Styling & Tokens:** Tailwind CSS 4 (`@tailwindcss/vite`), CSS variable tokens generated from `src/core/theme.ts` (Studio Dark, OLED Black, Daylight)
- **UI Components:** shadcn/ui (Radix, CLI-managed in `src/components/ui/`), Lucide icons, Sonner toasts, Motion
- **Routing & PWA:** TanStack Router (file routes, hash history for GitHub Pages), `vite-plugin-pwa` (`injectManifest` + Workbox in `sw/sw.ts`)
- **Audio & Library:** Native Web Audio API (`src/lib/audio-engine.ts`), custom Canvas waveforms, `music-metadata` + `idb-keyval` cache, `@leeoniya/ufuzzy`, `@tanstack/react-virtual`

## Rules
- Never place raw colors outside `src/core/theme.ts`.
- Never hand-edit `src/components/ui/` or `src/routeTree.gen.ts`.
- Run `bun run lint && bun run typecheck && bun test && bun run build` before finishing changes.
