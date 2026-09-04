import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  initialViewForPathname,
  pathnameForView,
  preserveKitchenHash
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
    ["/", "database"],
    ["/unknown", "database"]
  ] as const)("resolves pathname %s to %s", (pathname, expectedView) => {
    expect(initialViewForPathname(pathname)).toBe(expectedView);
  });

});

describe("PWA route", () => {
  it("keeps the kitchen fragment across in-app history changes", () => {
    const urls: Array<string | URL | null | undefined> = [];
    const history = {
      pushState: (_data: unknown, _unused: string, url?: string | URL | null) => { urls.push(url); },
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => { urls.push(url); },
    } as unknown as History;
    preserveKitchenHash(history, {
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
  });

  it("ships a full-app install manifest with a /shopping shortcut", async () => {
    const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
    const manifest = JSON.parse(
      await readFile(path.join(publicDir, "manifest.webmanifest"), "utf8")
    ) as {
      name: string;
      start_url: string;
      scope: string;
      display: string;
      icons: Array<{ src: string; sizes: string }>;
      shortcuts: Array<{ url: string }>;
    };

    expect(manifest).toMatchObject({
      name: "Enplace",
      start_url: "/",
      scope: "/",
      display: "standalone"
    });
    expect(manifest.shortcuts.map(({ url }) => url)).toContain("/shopping");
    expect(manifest.icons.map(({ sizes }) => sizes)).toEqual(["192x192", "512x512"]);
    for (const icon of manifest.icons) {
      const png = await readFile(path.join(publicDir, icon.src.replace(/^\//, "")));
      const expectedSize = Number.parseInt(icon.sizes, 10);
      expect(png.subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
      expect(png.readUInt32BE(16)).toBe(expectedSize);
      expect(png.readUInt32BE(20)).toBe(expectedSize);
      expect(png.byteLength).toBeGreaterThan(4096);
      expect(new Set(png).size).toBeGreaterThan(200);
    }
  });

  it("serves the canonical installed shell for offline navigation", async () => {
    const worker = await readFile(new URL("../pwa/service-worker.js", import.meta.url), "utf8");
    const build = await readFile(new URL("../../vite.config.ts", import.meta.url), "utf8");

    expect(worker).toContain('cache.match("/", { ignoreVary: true })');
    expect(worker).not.toContain('cache.match("/index.html"');
    expect(build).toContain('const files = new Set(["/", "/manifest.webmanifest"');
    expect(build).toContain('output.fileName !== "index.html"');
    expect(build).not.toContain('const files = new Set(["/index.html"');
  });

  it("preserves database contents layout and releases the mobile shopping sidebar width", async () => {
    const css = await readFile(new URL("../standalone.css", import.meta.url), "utf8");
    expect(css).toContain(".mep-database-panel { display: contents; }");
    const mobileStyles = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(mobileStyles).toContain(`.mep-shell--shopping .mep-sidebar {
    width: 100% !important;
    min-width: 0 !important;
    max-width: none !important;`);
  });


});
