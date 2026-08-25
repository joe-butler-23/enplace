import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  initialViewForPathname,
  pathnameForView,
  shoppingShareUrl
} from "./pwa-route";

describe("initial view route resolution", () => {
  it.each([
    ["/database", "database"],
    ["/database/", "database"],
    ["/shopping", "shopping"],
    ["/shopping/", "shopping"],
    ["/planner", "planner"],
    ["/", "planner"],
    ["/unknown", "planner"]
  ] as const)("resolves remote pathname %s to %s", (pathname, expectedView) => {
    expect(initialViewForPathname(pathname)).toBe(expectedView);
  });

});

describe("hosted PWA route", () => {
  it("maps views and shopping shares to their public paths", () => {
    expect(pathnameForView("shopping")).toBe("/shopping");
    expect(pathnameForView("database")).toBe("/database");
    expect(pathnameForView("planner")).toBe("/");
    expect(shoppingShareUrl("https://mep.example.ts.net")).toBe(
      "https://mep.example.ts.net/shopping"
    );
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

  it("releases the compact desktop sidebar width for the mobile shopping header", async () => {
    const css = await readFile(new URL("../standalone.css", import.meta.url), "utf8");
    const mobileStyles = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(mobileStyles).toContain(`.mep-shell--shopping .mep-sidebar {
    width: 100% !important;
    min-width: 0 !important;
    max-width: none !important;`);
  });
});
