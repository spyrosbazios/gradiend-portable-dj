import { QueryClient } from "@tanstack/react-query";
import { createHashHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
    },
  },
});

// Hash history ensures zero-config compatibility with GitHub Pages subpaths and offline PWA reloads
const hashHistory = createHashHistory();

export const router = createRouter({
  routeTree,
  history: hashHistory,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
