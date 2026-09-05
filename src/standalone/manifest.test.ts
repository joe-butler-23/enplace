// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installManifest } from "./manifest";

it("installs a manifest whose start URL and shortcut carry the cookbook link", async () => {
  document.head.innerHTML = "";
  installManifest("https://enplace.example", "e1_secret");
  const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href;
  expect(href).toMatch(/^data:application\/manifest\+json,/);
  const manifest = JSON.parse(decodeURIComponent(href.split(",")[1])) as {
    name: string;
    id: string;
    start_url: string;
    scope: string;
    display: string;
    icons: Array<{ src: string; sizes: string }>;
    shortcuts: Array<{ url: string }>;
  };
  expect(manifest).toMatchObject({
    name: "Enplace",
    id: "https://enplace.example/",
    start_url: "https://enplace.example/#k=e1_secret",
    scope: "https://enplace.example/",
    display: "standalone",
  });
  expect(manifest.shortcuts.map(({ url }) => url)).toEqual(["https://enplace.example/shopping#k=e1_secret"]);
  expect(manifest.icons.map(({ sizes }) => sizes)).toEqual(["192x192", "512x512"]);
  for (const icon of manifest.icons) {
    const png = await readFile(path.resolve("public", new URL(icon.src).pathname.replace(/^\//, "")));
    const expectedSize = Number.parseInt(icon.sizes, 10);
    expect(png.subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
    expect(png.readUInt32BE(16)).toBe(expectedSize);
    expect(png.readUInt32BE(20)).toBe(expectedSize);
    expect(png.byteLength).toBeGreaterThan(4096);
    expect(new Set(png).size).toBeGreaterThan(200);
  }
  // Rewriting the same link keeps one manifest element.
  installManifest("https://enplace.example", "e1_other");
  expect(document.querySelectorAll('link[rel="manifest"]')).toHaveLength(1);
});
