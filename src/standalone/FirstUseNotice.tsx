import * as React from "react";

export function FirstUseNotice({ busy, onCopyLink, onDownloadBackup }: {
  busy: boolean;
  onCopyLink: () => void;
  onDownloadBackup: () => void;
}): React.JSX.Element {
  return <aside className="mep-first-use-notice" aria-label="Save your cookbook link">
    <strong>Save your private cookbook link</strong>
    <p>This link is the only key to this cookbook. There is no account or recovery, so save it somewhere safe. Browser storage can be cleared or lost, and the hosted shared copy expires after 180 days without a connection.</p>
    <div className="mep-first-use-notice__actions">
      <button className="mep-button" type="button" disabled={busy} onClick={onCopyLink}>Copy link</button>
      <button className="mep-button" type="button" disabled={busy} onClick={onDownloadBackup}>Download backup</button>
    </div>
  </aside>;
}
