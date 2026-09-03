import * as React from "react";
import { unzipSync, zipSync } from "fflate";
import QRCode from "qrcode";
import { type KitchenStatus } from "@/host-client/kitchen-storage";
import { currentKitchenConnection } from "./current";
import {
  isKitchenId,
  kitchenIdFromUrl,
  kitchenLink,
  withKitchenHash,
} from "./doc";
import { clearCurrentKitchenId, setCurrentKitchenId } from "./registry";
import { SAMPLE_PATHS } from "./sample-pack";

const MAX_IMPORT_FILES = 500;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const REOPEN_SHARE_KEY = "enplace-reopen-share";

/** The boot listener reloads when this same-document navigation changes the kitchen fragment. */
function openKitchenLink(id: string): void {
  window.location.assign(withKitchenHash(window.location.href, id));
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




async function copyLink(link: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(link);
    notify("Kitchen link copied.");
  } catch (error) {
    notify(error instanceof Error ? error.message : "Could not copy the kitchen link.");
  }
}

export function consumeShareDialogRequest(): boolean {
  if (typeof sessionStorage === "undefined" || sessionStorage.getItem(REOPEN_SHARE_KEY) !== "1") return false;
  sessionStorage.removeItem(REOPEN_SHARE_KEY);
  return true;
}

export function ShareKitchenDialog({ onClose }: { onClose: () => void }): React.JSX.Element | null {
  const connection = currentKitchenConnection();
  const ref = React.useRef<HTMLDialogElement>(null);
  const [status, setStatus] = React.useState<KitchenStatus>(() => connection?.status() ?? "offline");
  const [showQr, setShowQr] = React.useState(false);
  const [qrUrl, setQrUrl] = React.useState("");
  const busy = false;
  const link = connection ? kitchenLink(window.location.origin, connection.id, window.location.pathname) : "";

  React.useEffect(() => {
    ref.current?.showModal();
    return () => { if (ref.current?.open) ref.current.close(); };
  }, []);

  React.useEffect(() => {
    if (!connection) return;
    setStatus(connection.status());
    return connection.onStatus(setStatus);
  }, [connection]);

  React.useEffect(() => {
    if (!showQr || !link) return;
    let current = true;
    void QRCode.toDataURL(link, { margin: 1, width: 180 }).then((url) => {
      if (current) setQrUrl(url);
    }).catch(() => {
      if (current) setQrUrl("");
    });
    return () => { current = false; };
  }, [link, showQr]);

  if (!connection) return null;

  const share = async (): Promise<void> => {
    if (navigator.share) {
      try {
        await navigator.share({ url: link });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          notify(error instanceof Error ? error.message : "Could not share the kitchen link.");
        }
      }
      return;
    }
    await copyLink(link);
  };


  return <dialog
    ref={ref}
    className="mep-dialog"
    aria-labelledby="mep-share-kitchen-title"
    onClose={onClose}
    onClick={(event) => { if (event.target === ref.current) ref.current?.close(); }}
  >
    <div className="mep-dialog__body">
      <button className="mep-dialog__close" type="button" onClick={() => ref.current?.close()} aria-label="Close share kitchen">×</button>
      <h2 id="mep-share-kitchen-title">Share kitchen</h2>
      <p>Anyone with this private link can view and change this kitchen.</p>
      <label>
        Kitchen link
        <input type="url" readOnly value={link} />
      </label>
      <div className="mep-kitchen-panel__actions">
        <button className="mep-button" type="button" disabled={busy} onClick={() => void share()}>Share</button>
        <button className="mep-button mep-button--ghost" type="button" disabled={busy} onClick={() => void copyLink(link)}>Copy link</button>
        <button className="mep-button mep-button--ghost" type="button" disabled={busy} onClick={() => setShowQr(true)}>Show QR code</button>
      </div>
      {showQr && qrUrl ? <img className="mep-kitchen-panel__qr" src={qrUrl} alt="QR code for this kitchen link" /> : null}
      <p className="mep-kitchen-panel__status">{statusMessage(status)}</p>
    </div>
  </dialog>;
}

export function KitchenPanel(): React.JSX.Element | null {
  const connection = currentKitchenConnection();
  const [busy, setBusy] = React.useState(false);
  const [hasSamples, setHasSamples] = React.useState(false);

  React.useEffect(() => {
    if (!connection) return;
    let current = true;
    void connection.adapter.walkFiles().then((files) => {
      if (!current) return;
      const paths = new Set(files.map(({ path }) => path));
      setHasSamples(SAMPLE_PATHS.some((path) => paths.has(path)));
    }).catch(() => undefined);
    return () => { current = false; };
  }, [connection]);

  if (!connection) return null;

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
      let expandedBytes = 0;
      let fileCount = 0;
      const checkLimits = (): void => {
        if (fileCount > MAX_IMPORT_FILES) throw new Error("Import is limited to 500 files.");
        if (expandedBytes > MAX_IMPORT_BYTES) throw new Error("Import is limited to 50 MB of expanded files.");
      };
      const accept = (size: number): void => {
        fileCount += 1;
        expandedBytes += size;
        checkLimits();
      };

      for (const file of Array.from(files)) {
        if (file.name.toLocaleLowerCase().endsWith(".zip")) {
          const countBeforeArchive = fileCount;
          const bytesBeforeArchive = expandedBytes;
          const bytes = new Uint8Array(await file.arrayBuffer());
          const archive = unzipSync(bytes, { filter: (entry) => {
            if (entry.name.endsWith("/")) return false;
            accept(entry.originalSize);
            return true;
          }});
          const archiveEntries = Object.entries(archive);
          fileCount = countBeforeArchive + archiveEntries.length;
          expandedBytes = bytesBeforeArchive + archiveEntries.reduce((total, [, value]) => total + value.byteLength, 0);
          checkLimits();
          for (const [path, zippedBytes] of archiveEntries) entries.push([path, zippedBytes]);
        } else {
          accept(file.size);
          entries.push([file.webkitRelativePath || file.name, new Uint8Array(await file.arrayBuffer())]);
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

  const startKitchen = async (): Promise<void> => {
    if (!window.confirm("Start a new kitchen? Keep this kitchen's link if you want to come back to it.")) return;
    setBusy(true);
    try {
      clearCurrentKitchenId();
      window.location.assign(`${window.location.pathname}${window.location.search}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not start a new kitchen.");
      setBusy(false);
    }
  };

  const openKitchenId = (id: string): void => {
    setCurrentKitchenId(id);
    openKitchenLink(id);
  };

  const pasteKitchenLink = (): void => {
    const value = window.prompt("Paste a kitchen link or kitchen id:")?.trim();
    if (!value) return;
    let id: string | null = null;
    try { id = kitchenIdFromUrl(value); } catch { id = null; }
    if (!id && isKitchenId(value)) id = value;
    if (!id) {
      notify("That is not a valid kitchen link or id.");
      return;
    }
    openKitchenId(id);
  };

  const removeSamples = async (): Promise<void> => {
    if (!window.confirm("Remove all sample recipes and their images?")) return;
    setBusy(true);
    try {
      const paths = new Set((await connection.adapter.walkFiles()).map(({ path }) => path));
      for (const path of SAMPLE_PATHS) if (paths.has(path)) await connection.adapter.remove(path);
      setHasSamples(false);
      notify("Removed sample recipes.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not remove the sample recipes.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mep-kitchen-panel">
      <h3>Kitchen</h3>

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
          {hasSamples ? <button className="mep-button mep-button--ghost" type="button" disabled={busy} onClick={() => void removeSamples()}>Remove sample recipes</button> : null}
        </div>
      </div>

      <div className="mep-kitchen-panel__section">
        <h4>Kitchens</h4>
        <button className="mep-button" type="button" disabled={busy} onClick={() => void startKitchen()}>
          Start a new kitchen
        </button>
        <button className="mep-button mep-button--ghost" type="button" disabled={busy} onClick={pasteKitchenLink}>
          Paste a link
        </button>
      </div>
    </section>
  );
}
