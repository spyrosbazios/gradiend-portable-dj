import { createFileRoute } from "@tanstack/react-router";
import { DjConsole, type MobileTab } from "@/components/dj-console";
import type { SortMode } from "@/components/library-panel";

interface ConsoleSearch {
  q?: string;
  sort?: SortMode;
  tab?: MobileTab;
}

const VALID_SORTS = new Set<SortMode>(["title", "artist", "filename"]);
const VALID_TABS = new Set<MobileTab>(["decks", "library", "queue"]);

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): ConsoleSearch => {
    const q = typeof search.q === "string" && search.q.length > 0 ? search.q : undefined;
    const sort =
      typeof search.sort === "string" && VALID_SORTS.has(search.sort as SortMode)
        ? (search.sort as SortMode)
        : undefined;
    const tab =
      typeof search.tab === "string" && VALID_TABS.has(search.tab as MobileTab)
        ? (search.tab as MobileTab)
        : undefined;
    return { q, sort, tab };
  },
  component: IndexRoute,
});

function IndexRoute() {
  const { q = "", sort = "title", tab = "decks" } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <DjConsole
      query={q}
      sortMode={sort}
      mobileTab={tab}
      onQueryChange={(nextQ) =>
        void navigate({
          search: (prev) => ({ ...prev, q: nextQ || undefined }),
          replace: true,
        })
      }
      onSortChange={(nextSort) =>
        void navigate({
          search: (prev) => ({
            ...prev,
            sort: nextSort === "title" ? undefined : nextSort,
          }),
          replace: true,
        })
      }
      onMobileTabChange={(nextTab) =>
        void navigate({
          search: (prev) => ({
            ...prev,
            tab: nextTab === "decks" ? undefined : nextTab,
          }),
          replace: true,
        })
      }
    />
  );
}
