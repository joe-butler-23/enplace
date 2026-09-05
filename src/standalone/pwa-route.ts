import { withCookbookHash } from "@/cookbook/doc";

export type PathnameView = "planner" | "shopping" | "database" | "settings" | "recipe";

/** The database is the app's landing view, so it owns "/". "/database" stays a valid
 *  alias for anything already bookmarked; the history effect canonicalises it to "/".
 *  "/recipe" is the one open recipe; its identity lives in app state, not the URL, so a
 *  cold load of "/recipe" has nothing to show and App canonicalises it back to "/". */
export function initialViewForPathname(pathname: string): PathnameView {
  const normalised = pathname.replace(/\/+$/, "");
  if (normalised === "/shopping") return "shopping";
  if (normalised === "/planner") return "planner";
  if (normalised === "/settings") return "settings";
  if (normalised === "/recipe") return "recipe";
  return "database";
}

export function pathnameForView(view: string): string {
  if (view === "shopping") return "/shopping";
  if (view === "planner") return "/planner";
  if (view === "settings") return "/settings";
  if (view === "recipe") return "/recipe";
  return "/";
}

/** Keep the active cookbook fragment when app navigation changes the pathname. */
export function preserveCookbookHash(
  history: History,
  location: Pick<Location, "href" | "origin">,
  id: string,
): void {
  const withCookbook = (value?: string | URL | null): string | URL | null | undefined => {
    if (value == null) return value;
    const url = new URL(value, location.href);
    if (url.origin !== location.origin) return value;
    return withCookbookHash(url.toString(), id);
  };
  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);
  history.pushState = (data, unused, url) => pushState(data, unused, withCookbook(url));
  history.replaceState = (data, unused, url) => replaceState(data, unused, withCookbook(url));
}
