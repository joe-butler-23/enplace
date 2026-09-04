import "./fonts.css";
import "../styles.css";
import "./standalone.css";
import { openKitchen } from "./host-client/kitchen-storage";
import { setCurrentKitchenConnection } from "./kitchen/current";
import {
  kitchenIdFromUrl,
  newKitchenId,
  withKitchenHash,
} from "./kitchen/doc";
import {
  clearCurrentKitchenId,
  currentKitchenId,
  setCurrentKitchenId,
} from "./kitchen/registry";
import { seedSamplePack } from "./kitchen/sample-pack";
import { preserveKitchenHash } from "./standalone/pwa-route";

const UNPUBLISHED_KITCHENS_KEY = "enplace-unpublished-kitchens";

function unpublishedKitchenIds(): Set<string> {
  try {
    const ids = JSON.parse(localStorage.getItem(UNPUBLISHED_KITCHENS_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function setKitchenUnpublished(id: string, unpublished: boolean): void {
  const ids = unpublishedKitchenIds();
  if (unpublished) ids.add(id);
  else ids.delete(id);
  if (ids.size) localStorage.setItem(UNPUBLISHED_KITCHENS_KEY, JSON.stringify([...ids]));
  else localStorage.removeItem(UNPUBLISHED_KITCHENS_KEY);
}

function configuredRelayUrl(): string | null {
  return (import.meta as ImportMeta & {
    env?: { VITE_ENPLACE_RELAY_URL?: string };
  }).env?.VITE_ENPLACE_RELAY_URL?.trim() || null;
}

type KitchenGate = { title: string; retry?: boolean };

function showKitchenGate({ title, retry = false }: KitchenGate): void {
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

async function openSharedKitchen(): Promise<boolean> {
  const linkedId = kitchenIdFromUrl(window.location.href);
  const rememberedId = currentKitchenId();
  const createdHere = linkedId === null && rememberedId === null;
  const id = linkedId ?? rememberedId ?? newKitchenId();
  if (createdHere) setKitchenUnpublished(id, true);
  const unpublished = unpublishedKitchenIds().has(id);
  setCurrentKitchenId(id);
  window.history.replaceState(null, "", withKitchenHash(window.location.href, id));
  preserveKitchenHash(window.history, window.location, id);
  window.addEventListener("hashchange", () => {
    if (kitchenIdFromUrl(window.location.href) !== id) window.location.reload();
  });

  try {
    const connection = await openKitchen({
      id,
      relayUrl: configuredRelayUrl(),
      seed: createdHere ? seedSamplePack : undefined,
      deferRelayUntilLocalWrite: unpublished,
      onFirstLocalWrite: () => setKitchenUnpublished(id, false),
    });
    setCurrentKitchenConnection(connection);
    if (!createdHere && !connection.hasLocalCopy) {
      showKitchenGate({ title: "Opening your shared kitchen…" });
      if (await connection.firstSync !== "synced") {
        showKitchenGate({
          title: "This device hasn't downloaded this kitchen yet. Connect to the internet once to open it.",
          retry: true,
        });
        return false;
      }
    }
    return true;
  } catch (error) {
    if (createdHere) {
      clearCurrentKitchenId();
      setKitchenUnpublished(id, false);
    }
    throw error;
  }
}

async function start(): Promise<void> {
  // Ask the browser to keep this site's storage; no prompt, no setting, just less eviction risk.
  if (navigator.storage?.persist) void navigator.storage.persist();
  const [{ mountApp }, opened] = await Promise.all([import("./mount"), openSharedKitchen()]);
  if (opened) mountApp();
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
  title.textContent = "Enplace could not open your kitchen";
  const detail = document.createElement("p");
  detail.textContent = reason instanceof Error
    ? reason.message
    : "Reload Enplace and try opening the kitchen again.";
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
