export type PathnameView = "planner" | "shopping" | "database";

export function initialViewForPathname(pathname: string): PathnameView {
  const normalised = pathname.replace(/\/+$/, "");
  if (normalised === "/shopping") return "shopping";
  if (normalised === "/database") return "database";
  return "planner";
}

export function pathnameForView(view: string): string {
  if (view === "shopping") return "/shopping";
  if (view === "database") return "/database";
  return "/";
}

export function shoppingShareUrl(origin: string): string {
  return new URL("/shopping", origin).toString();
}
