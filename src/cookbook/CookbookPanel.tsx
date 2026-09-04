import * as React from "react";
import { type CookbookStatus } from "@/host-client/cookbook-storage";
import { currentCookbookConnection } from "./current";
import {
  isCookbookId,
  cookbookIdFromUrl,
  cookbookLink,
  withCookbookHash,
} from "./doc";
import { clearCurrentCookbookId, setCurrentCookbookId } from "./registry";
import { SAMPLE_PATHS } from "./sample-pack";

const MAX_IMPORT_FILES = 500;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** The boot listener reloads when this same-document navigation changes the cookbook fragment. */
function openCookbookLink(id: string): void {
  window.location.assign(withCookbookHash(window.location.href, id));
}

const blobPart = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

function notify(message: string): void {
  window.dispatchEvent(new CustomEvent("mep-notice", { detail: { message } }));
}

function statusMessage(status: CookbookStatus): string {
  if (status === "local-only") return "This cookbook lives only on this device.";
  if (status === "connecting") return "Connecting to the relay…";
  if (status === "connected") return "Connected. Changes sync through the relay.";
  return "Offline. Changes will sync when the relay reconnects.";
}




async function copyLink(link: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(link);
    notify("Cookbook link copied.");
  } catch (error) {
    notify(error instanceof Error ? error.message : "Could not copy the cookbook link.");
  }
}

export function ShareCookbookDialog({ onClose }: { onClose: () => void }): React.JSX.Element | null {
  const connection = currentCookbookConnection();
  const ref = React.useRef<HTMLDialogElement>(null);
  const [status, setStatus] = React.useState<CookbookStatus>(() => connection?.status() ?? "offline");
  const [showQr, setShowQr] = React.useState(false);
  const [qrUrl, setQrUrl] = React.useState("");
  const link = connection ? cookbookLink(window.location.origin, connection.id, window.location.pathname) : "";

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
    void import("qrcode").then((qr) => qr.toDataURL(link, { margin: 1, width: 180 })).then((url) => {
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
          notify(error instanceof Error ? error.message : "Could not share the cookbook link.");
        }
      }
      return;
    }
    await copyLink(link);
  };


  return <dialog
    ref={ref}
    className="mep-dialog"
    aria-labelledby="mep-share-cookbook-title"
    onClose={onClose}
    onClick={(event) => { if (event.target === ref.current) ref.current?.close(); }}
  >
    <div className="mep-dialog__body">
      <button className="mep-dialog__close" type="button" onClick={() => ref.current?.close()} aria-label="Close share cookbook">×</button>
      <h2 id="mep-share-cookbook-title">Share cookbook</h2>
      <p>Anyone with this private link can view and change this cookbook.</p>
      <label>
        Cookbook link
        <input type="url" readOnly value={link} />
      </label>
      <div className="mep-cookbook-panel__actions">
        <button className="mep-button" type="button" onClick={() => void share()}>Share</button>
        <button className="mep-button mep-button--ghost" type="button" onClick={() => void copyLink(link)}>Copy link</button>
        <button className="mep-button mep-button--ghost" type="button" onClick={() => setShowQr(true)}>Show QR code</button>
      </div>
      {showQr && qrUrl ? <img className="mep-cookbook-panel__qr" src={qrUrl} alt="QR code for this cookbook link" /> : null}
      <p className="mep-cookbook-panel__status">{statusMessage(status)}</p>
    </div>
  </dialog>;
}

export function CookbookPanel(): React.JSX.Element | null {
  const connection = currentCookbookConnection();
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

  const downloadCookbook = async (): Promise<void> => {
    try {
      const files = await connection.adapter.walkFiles();
      const entries = Object.create(null) as Record<string, Uint8Array>;
      for (const { path, bytes } of files) entries[path] = bytes;
      const bytes = (await import("fflate")).zipSync(entries, { level: 6 });
      const url = URL.createObjectURL(new Blob([blobPart(bytes)], { type: "application/zip" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "enplace-cookbook.zip";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not download this cookbook.");
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
        if (file.name.toLowerCase().endsWith(".zip")) {
          const countBeforeArchive = fileCount;
          const bytesBeforeArchive = expandedBytes;
          const bytes = new Uint8Array(await file.arrayBuffer());
          const archive = (await import("fflate")).unzipSync(bytes, { filter: (entry) => {
            if (entry.name.endsWith("/")) return false;
            if (entry.name === "__proto__") throw new Error("Invalid folder path: __proto__");
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

      const imported = await connection.adapter.writeNewBytesBatch(entries);
      const skipped = entries.length - imported;
      notify(`Imported ${imported} file${imported === 1 ? "" : "s"}; skipped ${skipped} existing file${skipped === 1 ? "" : "s"}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not import these files.");
    } finally {
      setBusy(false);
    }
  };

  const startCookbook = async (): Promise<void> => {
    if (!window.confirm("Start a new cookbook? Keep this cookbook's link if you want to come back to it.")) return;
    setBusy(true);
    try {
      clearCurrentCookbookId();
      window.location.assign(`${window.location.pathname}${window.location.search}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not start a new cookbook.");
      setBusy(false);
    }
  };

  const openCookbookId = (id: string): void => {
    setCurrentCookbookId(id);
    openCookbookLink(id);
  };

  const pasteCookbookLink = (): void => {
    const value = window.prompt("Paste a cookbook link or cookbook id:")?.trim();
    if (!value) return;
    let id: string | null = null;
    try { id = cookbookIdFromUrl(value); } catch { id = null; }
    if (!id && isCookbookId(value)) id = value;
    if (!id) {
      notify("That is not a valid cookbook link or id.");
      return;
    }
    openCookbookId(id);
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
    <section className="mep-cookbook-panel">
      <h3>Cookbook</h3>

      <div className="mep-cookbook-panel__section">
        <h4>Your files</h4>
        <div className="mep-cookbook-panel__actions">
          <button className="mep-button" type="button" disabled={busy} onClick={() => void downloadCookbook()}>
            Download cookbook (.zip)
          </button>
          <label className="mep-button mep-button--ghost mep-cookbook-panel__file-button">
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

      <div className="mep-cookbook-panel__section">
        <h4>Cookbooks</h4>
        <button className="mep-button" type="button" disabled={busy} onClick={() => void startCookbook()}>
          Start a new cookbook
        </button>
        <button className="mep-button mep-button--ghost" type="button" disabled={busy} onClick={pasteCookbookLink}>
          Paste a link
        </button>
      </div>
    </section>
  );
}
