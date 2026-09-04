import { withKitchenHash } from "@/kitchen/doc";

export type PathnameView = "planner" | "shopping" | "database" | "settings";

/** The database is the app's landing view, so it owns "/". "/database" stays a valid
 *  alias for anything already bookmarked; the history effect canonicalises it to "/". */
export function initialViewForPathname(pathname: string): PathnameView {
  const normalised = pathname.replace(/\/+$/, "");
  if (normalised === "/shopping") return "shopping";
  if (normalised === "/planner") return "planner";
  if (normalised === "/settings") return "settings";
  return "database";
}

export function pathnameForView(view: string): string {
  if (view === "shopping") return "/shopping";
  if (view === "planner") return "/planner";
  if (view === "settings") return "/settings";
  return "/";
}

/** Keep the active kitchen fragment when app navigation changes the pathname. */
export function preserveKitchenHash(
  history: History,
  location: Pick<Location, "href" | "origin">,
  id: string,
): void {
  const withKitchen = (value?: string | URL | null): string | URL | null | undefined => {
    if (value == null) return value;
    const url = new URL(value, location.href);
    if (url.origin !== location.origin) return value;
    return withKitchenHash(url.toString(), id);
  };
  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);
  history.pushState = (data, unused, url) => pushState(data, unused, withKitchen(url));
  history.replaceState = (data, unused, url) => replaceState(data, unused, withKitchen(url));
}
