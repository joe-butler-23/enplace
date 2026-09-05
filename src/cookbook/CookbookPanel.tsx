import * as React from "react";
import { parseRecipe } from "@/core";
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

function statusMessage(status: CookbookStatus, preparing: boolean): string {
  if (preparing) return "Preparing the shared copy…";
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

/**
 * The link section of the settings dialog. One button, not two: where the platform has a
 * share sheet it opens that, and everywhere else it copies — so the label states which.
 * The link names the view behind the dialog, never the dialog's own /settings route.
 */
function CookbookLinkSection({ id, routePath }: { id: string; routePath: string }): React.JSX.Element {
  const connection = currentCookbookConnection();
  const [status, setStatus] = React.useState<CookbookStatus>(() => connection?.status() ?? "offline");
  const [remoteSynced, setRemoteSynced] = React.useState(() => connection?.remoteSynced() ?? false);
  const [qrUrl, setQrUrl] = React.useState("");
  const link = cookbookLink(window.location.origin, id, routePath);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  React.useEffect(() => {
    if (!connection) return;
    connection.publish();
    setStatus(connection.status());
    setRemoteSynced(connection.remoteSynced());
    const stopStatus = connection.onStatus(setStatus);
    const stopSync = connection.onRemoteSync(() => setRemoteSynced(true));
    return () => { stopStatus(); stopSync(); };
  }, [connection]);

  React.useEffect(() => {
    if (!link) return;
    let current = true;
    void import("qrcode").then((qr) => qr.toDataURL(link, { margin: 1, width: 180 })).then((url) => {
      if (current) setQrUrl(url);
    }).catch(() => {
      if (current) setQrUrl("");
    });
    return () => { current = false; };
  }, [link]);

  const share = async (): Promise<void> => {
    if (!canShare) {
      await copyLink(link);
      return;
    }
    try {
      await navigator.share({ url: link });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        notify(error instanceof Error ? error.message : "Could not share the cookbook link.");
      }
    }
  };

  return (
    <section className="mep-settings__section">
      <h3>Cookbook link</h3>
      <p className="mep-settings__note">Anyone with this private link can view and change this cookbook.</p>
      <input className="mep-settings__link" type="url" readOnly aria-label="Cookbook link" value={link} />
      <div className="mep-settings__actions">
        <button className="mep-button" type="button" onClick={() => void share()}>
          {canShare ? "Share link" : "Copy link"}
        </button>
      </div>
      {qrUrl ? <img className="mep-settings__qr" src={qrUrl} alt="QR code for this cookbook link" /> : null}
      <p className="mep-settings__note">{statusMessage(status, Boolean(connection?.relayUrl && !remoteSynced && status !== "offline"))}</p>
    </section>
  );
}

export function CookbookPanel({ routePath }: { routePath: string }): React.JSX.Element | null {
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

      const before = new Set((await connection.adapter.walkFiles()).map(({ path }) => path));
      const imported = await connection.adapter.writeNewBytesBatch(entries);
      const recognised = (await connection.adapter.walkFiles()).filter(({ path, bytes }) => (
        !before.has(path) && path.toLowerCase().endsWith(".md")
        && parseRecipe(path, new TextDecoder().decode(bytes)) !== null
      )).length;
      const skipped = entries.length - imported;
      notify(`Imported ${imported} file${imported === 1 ? "" : "s"}; skipped ${skipped} existing file${skipped === 1 ? "" : "s"}. ${recognised} recipe${recognised === 1 ? "" : "s"} recognised.`);
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
    <>
      <CookbookLinkSection id={connection.id} routePath={routePath} />

      <section className="mep-settings__section">
        <h3>Your files</h3>
        <div className="mep-settings__actions">
          <button className="mep-button" type="button" disabled={busy} onClick={() => void downloadCookbook()}>
            Download cookbook (.zip)
          </button>
          <label className="mep-button mep-button--ghost mep-settings__file-button">
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
      </section>

      <section className="mep-settings__section">
        <h3>Cookbooks</h3>
        <div className="mep-settings__actions">
          <button className="mep-button" type="button" disabled={busy} onClick={() => void startCookbook()}>
            Start a new cookbook
          </button>
          <button className="mep-button mep-button--ghost" type="button" disabled={busy} onClick={pasteCookbookLink}>
            Paste a link
          </button>
        </div>
      </section>
    </>
  );
}
