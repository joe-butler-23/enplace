/**
 * An installed app launches from the manifest's start_url, not the page it was added from,
 * so the manifest is written once the cookbook is known and carries the link in its fragment.
 * A data: URL keeps the secret off the network; every URL is absolute because relative ones
 * cannot resolve against a data: base.
 */
export function installManifest(origin: string, id: string): void {
  const manifest = {
    name: "Enplace",
    short_name: "Enplace",
    description: "The full Enplace app: recipe database, weekly planner, and shopping list.",
    id: `${origin}/`,
    start_url: `${origin}/#k=${id}`,
    scope: `${origin}/`,
    display: "standalone",
    background_color: "#f7efe5",
    theme_color: "#a64b2a",
    icons: [
      { src: `${origin}/icons/icon-192.png`, sizes: "192x192", type: "image/png" },
      { src: `${origin}/icons/icon-512.png`, sizes: "512x512", type: "image/png" },
    ],
    shortcuts: [{ name: "Shopping list", short_name: "Shopping", url: `${origin}/shopping#k=${id}` }],
  };
  let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "manifest";
    document.head.append(link);
  }
  link.href = `data:application/manifest+json,${encodeURIComponent(JSON.stringify(manifest))}`;
}
