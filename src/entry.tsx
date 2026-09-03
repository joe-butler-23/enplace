import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/space-grotesk";
import "../styles.css";
import "./standalone.css";
import { useVaultStorage } from "./host-client/browser-storage";
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

function configuredRelayUrl(): string | null {
  return (import.meta as ImportMeta & {
    env?: { VITE_ENPLACE_RELAY_URL?: string };
  }).env?.VITE_ENPLACE_RELAY_URL?.trim() || null;
}

async function openSharedKitchen(): Promise<void> {
  const linkedId = kitchenIdFromUrl(window.location.href);
  const rememberedId = currentKitchenId();
  const created = linkedId === null && rememberedId === null;
  const id = linkedId ?? rememberedId ?? newKitchenId();
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
      seed: created ? seedSamplePack : undefined,
    });
    useVaultStorage(connection.adapter);
    setCurrentKitchenConnection(connection);
  } catch (error) {
    if (created) clearCurrentKitchenId();
    throw error;
  }
}

async function start(): Promise<void> {
  await openSharedKitchen();
  await import("./standalone/direct-database-bootstrap");
  await import("./mount");
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
