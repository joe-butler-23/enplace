import "./fonts.css";
import "../styles.css";
import "./standalone.css";
import type * as Y from "yjs";
import { openCookbook } from "./host-client/cookbook-storage";
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

type CookbookGate = { title: string; retry?: boolean };

function showCookbookGate({ title, retry = false }: CookbookGate): void {
  const container = document.getElementById("root");
  if (!container) return;
  const main = document.createElement("main");
  main.className = "mep-vault-gate";
  const card = document.createElement("section");
  card.className = "mep-vault-gate__card";
  const heading = document.createElement("h1");
  heading.textContent = title;
  card.append(heading);
  if (retry) {
    const button = document.createElement("button");
    button.className = "mep-button";
    button.type = "button";
    button.textContent = "Retry";
    button.addEventListener("click", () => window.location.reload());
    card.append(button);
  }
  main.append(card);
  container.replaceChildren(main);
}

type CookbookSession = { doc: Y.Doc; seededHere: boolean };

async function openSharedCookbook(): Promise<CookbookSession | null> {
  const linkedId = cookbookIdFromUrl(window.location.href);
  const rememberedId = currentCookbookId();
  const createdHere = linkedId === null && rememberedId === null;
  const id = linkedId ?? rememberedId ?? newCookbookId();
  if (createdHere) setCookbookUnpublished(id, true);
  const unpublished = unpublishedCookbookIds().has(id);
  setCurrentCookbookId(id);
  window.history.replaceState(null, "", withCookbookHash(window.location.href, id));
  preserveCookbookHash(window.history, window.location, id);
  window.addEventListener("hashchange", () => {
    if (cookbookIdFromUrl(window.location.href) !== id) window.location.reload();
  });

  try {
    const connection = await openCookbook({
      id,
      relayUrl: configuredRelayUrl(),
      seed: createdHere ? seedSamplePack : undefined,
      deferRelayUntilLocalWrite: unpublished,
      onFirstLocalWrite: () => setCookbookUnpublished(id, false),
    });
    setCurrentCookbookConnection(connection);
    if (!createdHere && !connection.hasLocalCopy) {
      showCookbookGate({ title: "Opening your shared cookbook…" });
      if (await connection.firstSync !== "synced") {
        showCookbookGate({
          title: "This device hasn't downloaded this cookbook yet. Connect to the internet once to open it.",
          retry: true,
        });
        return null;
      }
    }
    void backfillCookbookCovers(connection.doc).then(async () => {
      if (await connection.firstSync === "synced") await backfillCookbookCovers(connection.doc);
    }).catch((error) => {
      console.warn("Could not finish automatic cover optimization:", error);
    });
    return { doc: connection.doc, seededHere: createdHere };
  } catch (error) {
    if (createdHere) {
      clearCurrentCookbookId();
      setCookbookUnpublished(id, false);
    }
    throw error;
  }
}

async function start(): Promise<void> {
  // Ask the browser to keep this site's storage; no prompt, no setting, just less eviction risk.
  if (navigator.storage?.persist) void navigator.storage.persist();
  const [{ mountApp }, session] = await Promise.all([import("./mount"), openSharedCookbook()]);
  if (!session) return;
  mountApp();
  // Only a cookbook this visit seeded is missing its full covers, so no existing-cookbook
  // visit ever fetches this pack. Nothing on screen waits for it.
  if (session.seededHere) {
    void seedSampleCovers(session.doc).catch((error) => {
      console.warn("Could not finish loading the sample cover images:", error);
    });
  }
}

function showStartupFailure(reason: unknown): void {
  const container = document.getElementById("root");
  if (!container) return;
  const main = document.createElement("main");
  main.className = "mep-vault-gate";
  main.setAttribute("role", "alert");
  const card = document.createElement("section");
  card.className = "mep-vault-gate__card";
  const title = document.createElement("h1");
  title.textContent = "Enplace could not open your cookbook";
  const detail = document.createElement("p");
  detail.textContent = reason instanceof Error
    ? reason.message
    : "Reload Enplace and try opening the cookbook again.";
  const reload = document.createElement("button");
  reload.className = "mep-button";
  reload.type = "button";
  reload.textContent = "Reload Enplace";
  reload.addEventListener("click", () => window.location.reload());
  card.append(title, detail, reload);
  main.append(card);
  container.replaceChildren(main);
}

void start().catch(showStartupFailure);
