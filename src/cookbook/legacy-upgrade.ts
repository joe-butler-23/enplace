import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import { zipSync } from "fflate";
import { IndexeddbPersistence } from "y-indexeddb";
import { openCookbook } from "../host-client/cookbook-storage";
import { newCookbookId, walkCookbookFiles, withCookbookHash } from "./doc";
import { setCurrentCookbookId } from "./registry";

const LEGACY_READ_DEADLINE_MS = 15_000;

/** One receive-only sync request. This socket never sends a cookbook update. */
export async function readLegacyCookbook(url: string, id: string, signal: AbortSignal,
  Socket: typeof WebSocket = WebSocket): Promise<Uint8Array> {
  if (!/^[a-z2-7]{26}$/.test(id)) throw new Error("Invalid previous cookbook link.");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new Socket(`${url.replace(/\/$/, "")}/${id}`);
    socket.binaryType = "arraybuffer";
    let finished = false;
    const finish = (error?: unknown, update?: Uint8Array): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
      if (error) reject(error); else resolve(update!);
    };
    const abort = (): void => finish(signal.reason);
    const deadline = setTimeout(() => finish(new Error("The previous shared copy is unavailable. Try again when connected.")), LEGACY_READ_DEADLINE_MS);
    signal.addEventListener("abort", abort, { once: true });
    // y-websocket sync / sync-step-1 / one-byte empty state vector.
    socket.onopen = () => socket.send(new Uint8Array([0, 0, 1, 0]));
    socket.onerror = () => finish(new Error("Could not retrieve the previous shared cookbook."));
    socket.onclose = () => finish(new Error("The previous cookbook connection closed before download."));
    socket.onmessage = ({ data }) => {
      if (!(data instanceof ArrayBuffer)) return;
      try {
        const message = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(message) !== 0 || decoding.readVarUint(message) !== 1) return;
        finish(undefined, decoding.readVarUint8Array(message));
      } catch (error) { finish(error); }
    };
  });
}

/** The plaintext copy this device saved under the historical database name, read in place. */
async function openPreviousCopy(id: string): Promise<{ doc: Y.Doc; ready: boolean; close: () => Promise<void> }> {
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(`enplace-kitchen-${id}`, doc);
  await persistence.whenSynced;
  const ready = (await persistence.get("has-local-copy")) === 1;
  return { doc, ready, close: async () => { await persistence.destroy(); doc.destroy(); } };
}

/** The old data is retained. No secret or redirect is ever written into the old relay room. */
export async function showLegacyUpgrade(id: string, relayUrl: string | null, signal: AbortSignal): Promise<void> {
  const mappingKey = `enplace-upgraded-${id}`;
  const existing = localStorage.getItem(mappingKey);
  if (existing && /^e1_[a-z2-7]{52}$/.test(existing)) {
    window.history.replaceState(null, "", withCookbookHash(window.location.href, existing));
    window.location.reload();
    return;
  }
  const root = document.getElementById("root")!;
  const main = document.createElement("main");
  main.className = "mep-vault-gate";
  const card = document.createElement("section");
  card.className = "mep-vault-gate__card";
  const title = document.createElement("h1");
  title.textContent = "Secure this cookbook";
  const explanation = document.createElement("p");
  explanation.textContent = "This cookbook uses an older sharing link. Upgrade creates an encrypted copy and a new link to send to your partner. If your partner has already upgraded, open their new link instead.";
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  const upgrade = document.createElement("button");
  upgrade.className = "mep-button";
  upgrade.textContent = "Upgrade cookbook";
  const download = document.createElement("button");
  download.className = "mep-button";
  download.textContent = "Download previous cookbook (.zip)";
  card.append(title, explanation, upgrade, download, message);
  main.append(card);
  root.replaceChildren(main);

  const run = async (action: "upgrade" | "download"): Promise<void> => {
    upgrade.disabled = download.disabled = true;
    let source: Awaited<ReturnType<typeof openPreviousCopy>> | null = null;
    try {
      source = await openPreviousCopy(id);
      signal.throwIfAborted();
      if (relayUrl) {
        try { Y.applyUpdate(source.doc, await readLegacyCookbook(relayUrl, id, signal)); }
        catch (error) {
          signal.throwIfAborted();
          if (!source.ready) throw error;
          // An offline cached copy stays exportable. Upgrading waits for the shared
          // copy so recent partner edits cannot silently disappear from the new link.
          if (action === "upgrade") throw new Error("Reconnect to include your partner's latest changes before upgrading. You can still download this device's saved copy.");
          message.textContent = "Downloaded this device's saved copy; the shared copy was unavailable.";
        }
      } else if (!source.ready) throw new Error("No saved copy was found on this device.");
      signal.throwIfAborted();
      if (action === "download") {
        const entries = Object.fromEntries(walkCookbookFiles(source.doc).map(({ path, bytes }) => [path, bytes]));
        const bytes = zipSync(entries);
        const href = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/zip" }));
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = "enplace-previous-cookbook.zip";
        anchor.click();
        URL.revokeObjectURL(href);
      } else {
        const next = newCookbookId();
        const snapshot = Y.encodeStateAsUpdate(source.doc);
        const target = await openCookbook({ id: next, relayUrl: null, signal,
          seed: (doc) => { Y.applyUpdate(doc, snapshot); } });
        await target.close();
        signal.throwIfAborted();
        localStorage.setItem(mappingKey, next);
        setCurrentCookbookId(next);
        window.history.replaceState(null, "", withCookbookHash(window.location.href, next));
        window.location.reload();
      }
    } catch (error) {
      if (!signal.aborted) message.textContent = error instanceof Error ? error.message : "Could not open the previous cookbook.";
    } finally {
      await source?.close();
      upgrade.disabled = download.disabled = false;
    }
  };
  upgrade.addEventListener("click", () => { void run("upgrade"); }, { signal });
  download.addEventListener("click", () => { void run("download"); }, { signal });
}
