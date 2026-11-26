import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";
import { themePlugin } from "./src/core/theme-plugin.ts";
import { devMusicPlugin } from "./src/core/dev-music-plugin.ts";
import { DEFAULT_THEME, THEMES } from "./src/core/theme.ts";

const base = process.env.VITE_BASE_PATH ?? "./";
const devMusicDir = process.env.DEV_MUSIC_DIR ?? "/media/snm/SANDISK/Music";
const defaultBg = THEMES[DEFAULT_THEME].C.bg;

export default defineConfig({
  base,
  define: {
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
    __APP_VERSION__: JSON.stringify("0.1.0"),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    themePlugin(),
    devMusicPlugin(devMusicDir),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "sw",
      filename: "sw.ts",
      registerType: "prompt",
      includeAssets: [
        "icon.svg",
        "icon-192.png",
        "icon-512.png",
        "icon-maskable-512.png",
        "apple-touch-icon.png",
      ],
      manifest: {
        id: "./",
        name: "Portable DJ",
        short_name: "Portable DJ",
        description: "Noob-proof portable DJ console with auto-play queue and anti-embarrassment guardrails.",
        theme_color: defaultBg,
        background_color: defaultBg,
        display: "standalone",
        orientation: "any",
        start_url: ".",
        scope: ".",
        icons: [
          {
            src: "icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,woff2,ttf,png,svg}"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
});
