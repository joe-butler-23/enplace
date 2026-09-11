import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/dialogs.css";
import "./styles/database.css";
import "./styles/planner.css";
import "./styles/recipe.css";
import "./styles/shopping.css";
import type * as Y from "yjs";
import { openCookbookAttempt } from "./cookbook/opening";
import { setCurrentCookbookConnection } from "./cookbook/current";
import {
  cookbookIdFromUrl,
  newCookbookId,
  withCookbookHash,
} from "./cookbook/doc";
import {
  clearCurrentCookbookId,
  currentCookbookId,
  setCurrentCookbookId,
} from "./cookbook/registry";
import { seedSampleCovers, seedSamplePack } from "./cookbook/sample-pack";
import { backfillCookbookCovers } from "./cookbook/covers";
import { preserveCookbookHash } from "./standalone/pwa-route";
import { installManifest } from "./standalone/manifest";

// Historical kitchens key stays unchanged so unpublished state survives the rename.
const UNPUBLISHED_COOKBOOKS_KEY = "enplace-unpublished-kitchens";

function unpublishedCookbookIds(): Set<string> {
  try {
    const ids = JSON.parse(localStorage.getItem(UNPUBLISHED_COOKBOOKS_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function setCookbookUnpublished(id: string, unpublished: boolean): void {
  const ids = unpublishedCookbookIds();
  if (unpublished) ids.add(id);
  else ids.delete(id);
  if (ids.size) localStorage.setItem(UNPUBLISHED_COOKBOOKS_KEY, JSON.stringify([...ids]));
  else localStorage.removeItem(UNPUBLISHED_COOKBOOKS_KEY);
}

function configuredRelayUrl(): string | null {
  return (import.meta as ImportMeta & {
    env?: { VITE_ENPLACE_RELAY_URL?: string };
  }).env?.VITE_ENPLACE_RELAY_URL?.trim() || null;
}

type Gate = { title: string; detail: string; action: string; alert?: boolean };

/** The card shown in place of the app, before it mounts: a title, one line, and a reload. */
function showGate({ title, detail, action, alert = false }: Gate): void {
  const container = document.getElementById("root");
  if (!container) return;
  const main = document.createElement("main");
  main.className = "mep-gate";
  if (alert) main.setAttribute("role", "alert");
  const card = document.createElement("section");
  card.className = "mep-gate__card";
  const heading = document.createElement("h1");
  heading.textContent = title;
  const text = document.createElement("p");
  text.textContent = detail;
  const button = document.createElement("button");
  button.className = "mep-button";
  button.type = "button";
  button.textContent = action;
  button.addEventListener("click", () => window.location.reload());
  card.append(heading, text, button);
  main.append(card);
  container.replaceChildren(main);
}

type CookbookSession = { doc: Y.Doc; seededHere: boolean };

async function openSharedCookbook(signal: AbortSignal): Promise<CookbookSession | null> {
  const linkedId = cookbookIdFromUrl(window.location.href);
  const rememberedId = currentCookbookId();
  const createdHere = linkedId === null && rememberedId === null;
  const id = linkedId ?? rememberedId ?? newCookbookId();
  if (createdHere) setCookbookUnpublished(id, true);
  const unpublished = unpublishedCookbookIds().has(id);
  setCurrentCookbookId(id);
  installManifest(window.location.origin, id);
  window.history.replaceState(null, "", withCookbookHash(window.location.href, id));
  preserveCookbookHash(window.history, window.location, id);
  window.addEventListener("hashchange", () => {
    if (cookbookIdFromUrl(window.location.href) !== id) {
      opening.abort();
      window.location.reload();
    }
  }, { signal });

  try {
    const connection = await openCookbookAttempt({
      id,
      relayUrl: configuredRelayUrl(),
      seed: createdHere ? seedSamplePack : undefined,
      deferRelayUntilLocalWrite: unpublished,
      onFirstLocalWrite: () => setCookbookUnpublished(id, false),
    }, signal, (warning) => showGate(warning === "storage" ? {
      title: "Still opening your cookbook",
      detail: "Cookbook storage is taking longer than expected. Close other Enplace tabs or reload.",
      action: "Retry",
    } : {
      title: "Waiting for this cookbook",
      detail: "This device hasn't downloaded this cookbook yet. Check your connection; it will open automatically when available.",
      action: "Retry",
    }));
    if (!connection || signal.aborted) { void connection?.close(); return null; }
    // The plaintext copy persisted before the wire document became the persisted copy.
    indexedDB.deleteDatabase(`enplace-kitchen-${id}`);
    setCurrentCookbookConnection(connection);
    const close = (): void => {
      stopRemote();
      setCurrentCookbookConnection(null);
      void connection.close().catch(() => {});
    };
    signal.addEventListener("abort", close, { once: true });
    const backfill = async (): Promise<void> => {
      if (!signal.aborted) await backfillCookbookCovers(connection.doc).catch((error) => {
        console.warn("Could not finish automatic cover optimization:", error);
      });
    };
    const initialBackfill = backfill();
    let stopRemote = (): void => {};
    stopRemote = connection.onRemoteSync(() => {
      stopRemote();
      void initialBackfill.then(backfill);
    });
    if (connection.remoteSynced()) stopRemote();
    return { doc: connection.doc, seededHere: createdHere };
  } catch (error) {
    if (createdHere && !signal.aborted) {
      clearCurrentCookbookId();
      setCookbookUnpublished(id, false);
    }
    throw error;
  }
}

const opening = new AbortController();
window.addEventListener("pagehide", () => opening.abort(), { once: true });
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

async function start(): Promise<void> {
  // Ask the browser to keep this site's storage; no prompt, no setting, just less eviction risk.
  if (navigator.storage?.persist) void navigator.storage.persist();
  const [{ mountApp }, session] = await Promise.all([import("./mount"), openSharedCookbook(opening.signal)]);
  if (!session || opening.signal.aborted) return;
  mountApp();
  // Only a cookbook this visit seeded is missing its full covers, so no existing-cookbook
  // visit ever fetches this pack. Nothing on screen waits for it.
  if (session.seededHere) {
    void seedSampleCovers(session.doc).catch((error) => {
      console.warn("Could not finish loading the sample cover images:", error);
    });
  }
}

void start().catch((error) => {
  if (!opening.signal.aborted) {
    opening.abort();
    showGate({
      title: "Enplace could not open your cookbook",
      detail: error instanceof Error ? error.message : "Reload Enplace and try opening the cookbook again.",
      action: "Reload Enplace",
      alert: true,
    });
  }
});
