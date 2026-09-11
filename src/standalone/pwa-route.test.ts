import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  initialViewForPathname,
  pathnameForView,
  preserveCookbookHash
} from "./pwa-route";

describe("initial view route resolution", () => {
  it.each([
    ["/database", "database"],
    ["/database/", "database"],
    ["/settings", "settings"],
    ["/shopping", "shopping"],
    ["/shopping/", "shopping"],
    ["/planner", "planner"],
    ["/planner/", "planner"],
    ["/recipe", "recipe"],
    ["/recipe/", "recipe"],
    ["/", "database"],
    ["/unknown", "database"]
  ] as const)("resolves pathname %s to %s", (pathname, expectedView) => {
    expect(initialViewForPathname(pathname)).toBe(expectedView);
  });

});

describe("PWA route", () => {
  it("keeps the cookbook fragment across in-app history changes", () => {
    const urls: Array<string | URL | null | undefined> = [];
    const history = {
      pushState: (_data: unknown, _unused: string, url?: string | URL | null) => { urls.push(url); },
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => { urls.push(url); },
    } as unknown as History;
    preserveCookbookHash(history, {
      href: "https://enplace.example/planner#k=old",
      origin: "https://enplace.example",
    }, "abcdefghijklmnopqrstuvwxyz");

    history.pushState(null, "", "/shopping");
    history.replaceState(null, "", "/settings?tab=files#ignored");

    expect(urls).toEqual([
      "/shopping#k=abcdefghijklmnopqrstuvwxyz",
      "/settings?tab=files#k=abcdefghijklmnopqrstuvwxyz",
    ]);
  });

  it("maps views to their public paths", () => {
    expect(pathnameForView("shopping")).toBe("/shopping");
    expect(pathnameForView("database")).toBe("/");
    expect(pathnameForView("settings")).toBe("/settings");
    expect(pathnameForView("planner")).toBe("/planner");
    expect(pathnameForView("recipe")).toBe("/recipe");
  });

  it("serves the canonical installed shell for offline navigation", async () => {
    const worker = await readFile(new URL("../pwa/service-worker.js", import.meta.url), "utf8");
    const build = await readFile(new URL("../../vite.config.ts", import.meta.url), "utf8");

    expect(worker).toContain('cache.match("/", { ignoreVary: true })');
    expect(worker).not.toContain('cache.match("/index.html"');
    expect(build).toContain('const files = new Set(["/", "/enplace-mark.png"');
    expect(build).toContain('output.fileName !== "index.html"');
    expect(build).not.toContain('const files = new Set(["/index.html"');
  });
});
