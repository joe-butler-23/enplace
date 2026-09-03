import * as React from "react";
import { unzipSync, zipSync } from "fflate";
import QRCode from "qrcode";
import { openKitchen, type KitchenStatus } from "@/host-client/kitchen-storage";
import { currentKitchenConnection } from "./current";
import {
  isKitchenId,
  kitchenIdFromUrl,
  kitchenLink,
  newKitchenId,
  withKitchenHash,
} from "./doc";
import { setCurrentKitchenId } from "./registry";
import { seedSamplePack } from "./sample-pack";

/** A fragment-only change is a same-document navigation, so boot must be forced to rerun. */
function openKitchenLink(id: string): void {
  window.location.assign(withKitchenHash(window.location.href, id));
  window.location.reload();
}

const blobPart = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

function notify(message: string): void {
  window.dispatchEvent(new CustomEvent("mep-notice", { detail: { message } }));
}

function statusMessage(status: KitchenStatus): string {
  if (status === "local-only") return "This kitchen lives only on this device.";
  if (status === "connecting") return "Connecting to the relay…";
  if (status === "connected") return "Connected. Changes sync through the relay.";
  return "Offline. Changes will sync when the relay reconnects.";
}

export function KitchenPanel(): React.JSX.Element | null {
  const connection = currentKitchenConnection();
  const [status, setStatus] = React.useState<KitchenStatus>(() => connection?.status() ?? "offline");
  const [qrUrl, setQrUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const link = connection ? kitchenLink(window.location.origin, connection.id) : "";

  React.useEffect(() => {
    if (!connection) return;
    setStatus(connection.status());
    return connection.onStatus(setStatus);
  }, [connection]);

  React.useEffect(() => {
    if (!link) return;
    let current = true;
    void QRCode.toDataURL(link, { margin: 1, width: 180 }).then((url) => {
      if (current) setQrUrl(url);
    }).catch(() => {
      if (current) setQrUrl("");
    });
    return () => { current = false; };
  }, [link]);

  if (!connection) return null;

  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link);
      notify("Kitchen link copied.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not copy the kitchen link.");
    }
  };

  const downloadKitchen = async (): Promise<void> => {
    try {
      const files = await connection.adapter.walkFiles();
      const entries: Record<string, Uint8Array> = {};
      for (const { path, file } of files) entries[path] = new Uint8Array(await file.arrayBuffer());
      const bytes = zipSync(entries, { level: 6 });
      const url = URL.createObjectURL(new Blob([blobPart(bytes)], { type: "application/zip" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "enplace-kitchen.zip";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not download this kitchen.");
    }
  };

  const importFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const entries: Array<readonly [string, Uint8Array]> = [];
      for (const file of Array.from(files)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (file.name.toLocaleLowerCase().endsWith(".zip")) {
          for (const [path, zippedBytes] of Object.entries(unzipSync(bytes))) {
            if (!path.endsWith("/")) entries.push([path, zippedBytes]);
          }
        } else {
          entries.push([file.webkitRelativePath || file.name, bytes]);
        }
      }

      let imported = 0;
      let skipped = 0;
      for (const [path, bytes] of entries) {
        if (await connection.adapter.pathExists(path)) {
          skipped += 1;
          continue;
        }
        await connection.adapter.writeNewBytes(path, bytes);
        imported += 1;
      }
      notify(`Imported ${imported} file${imported === 1 ? "" : "s"}; skipped ${skipped} existing file${skipped === 1 ? "" : "s"}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not import these files.");
    } finally {
      setBusy(false);
    }
  };

  const initializeKitchen = async (id: string): Promise<void> => {
    const created = await openKitchen({
      id,
      relayUrl: connection.relayUrl,
      seed: seedSamplePack,
    });
    await created.close();
    setCurrentKitchenId(id);
    openKitchenLink(id);
  };

  const startKitchen = async (): Promise<void> => {
    if (!window.confirm("Start a new kitchen? Your current kitchen will remain on this device.")) return;
    setBusy(true);
    try {
      await initializeKitchen(newKitchenId());
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not start a new kitchen.");
      setBusy(false);
    }
  };

  const openAnotherKitchen = (): void => {
    const value = window.prompt("Paste a kitchen link or kitchen id:")?.trim();
    if (!value) return;
    let id: string | null = null;
    try { id = kitchenIdFromUrl(value); } catch { id = null; }
    if (!id && isKitchenId(value)) id = value;
    if (!id) {
      notify("That is not a valid kitchen link or id.");
      return;
    }
    setCurrentKitchenId(id);
    openKitchenLink(id);
  };

  return (
    <section className="mep-kitchen-panel">
      <h3>Kitchen</h3>

      <div className="mep-kitchen-panel__section">
        <h4>Share</h4>
        <label>
          Kitchen link
          <input type="url" readOnly value={link} />
        </label>
        <button className="mep-button" type="button" onClick={() => void copyLink()}>Copy link</button>
        {qrUrl ? <img className="mep-kitchen-panel__qr" src={qrUrl} alt="QR code for this kitchen link" /> : null}
        <p className="mep-kitchen-panel__status">{statusMessage(status)}</p>
      </div>

      <div className="mep-kitchen-panel__section">
        <h4>Your files</h4>
        <div className="mep-kitchen-panel__actions">
          <button className="mep-button" type="button" disabled={busy} onClick={() => void downloadKitchen()}>
            Download kitchen (.zip)
          </button>
          <label className="mep-button mep-button--ghost mep-kitchen-panel__file-button">
            Import files
            <input
              type="file"
              multiple
              disabled={busy}
              onChange={(event) => {
                void importFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
        </div>
      </div>

      <div className="mep-kitchen-panel__section">
        <h4>Kitchens</h4>
        <div className="mep-kitchen-panel__actions">
          <button className="mep-button" type="button" disabled={busy} onClick={() => void startKitchen()}>
            Start a new kitchen
          </button>
          <button className="mep-button mep-button--ghost" type="button" disabled={busy} onClick={openAnotherKitchen}>
            Open another kitchen
          </button>
        </div>
      </div>
    </section>
  );
}
