import { ACCENTS, DEFAULT_THEME, THEMES, themeVars } from "./theme.ts";
import { PREFS_KEY } from "../lib/storage-keys.ts";

const VIRTUAL_ID = "virtual:app-theme.css";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export function themePlugin() {
  return {
    name: "app-theme-plugin",
    resolveId(id: string) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    load(id: string) {
      if (id !== RESOLVED_ID) return undefined;
      const t = THEMES[DEFAULT_THEME];
      const entries = Object.entries(themeVars(t))
        .map(([k, v]) => `  --app-${k}: ${v};`)
        .join("\n");
      return `:root {\n  color-scheme: ${t.scheme};\n${entries}\n}\n`;
    },
    transformIndexHtml(html: string) {
      const themesTuple = Object.fromEntries(
        Object.entries(THEMES).map(([k, t]) => [k, [t.C.bg, t.C.fg, t.C.brand, t.scheme]]),
      );
      const accentsTuple = Object.fromEntries(
        Object.entries(ACCENTS).map(([k, a]) => [k, [a.dark, a.light]]),
      );
      const bootScript = `(function(){var T=${JSON.stringify(themesTuple)},A=${JSON.stringify(accentsTuple)},t=${JSON.stringify(DEFAULT_THEME)},a="theme";try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(PREFS_KEY)})||"{}")||{};if(T[p.theme])t=p.theme;if(p.accent==="theme"||A[p.accent])a=p.accent;}catch(e){}var l=T[t],s=l[3],b=a==="theme"?l[2]:A[a][s==="dark"?0:1],r=document.documentElement;r.style.setProperty("--app-bg",l[0]);r.style.setProperty("--app-fg",l[1]);r.style.setProperty("--app-brand",b);r.style.colorScheme=s;r.classList.toggle("dark",s==="dark");r.dataset.scheme=s;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",l[0]);})();`;
      const splashStyle = `#splash{position:fixed;inset:0;z-index:1000;background:var(--app-bg);transition:opacity 300ms cubic-bezier(0.23,1,0.32,1);}#splash[data-done]{opacity:0;pointer-events:none;}@media (prefers-reduced-motion:reduce){#splash{transition:none;}}`;
      return html
        .replace(
          "</head>",
          `  <style>${splashStyle}</style>\n  <script>${bootScript}</script>\n</head>`,
        )
        .replace("<body>", `<body>\n  <div id="splash" aria-hidden="true"></div>`);
    },
  };
}
