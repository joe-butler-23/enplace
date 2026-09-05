import * as React from "react";

export function PwaLifecycle({ children }: React.PropsWithChildren): React.JSX.Element {
  const [update, setUpdate] = React.useState<ServiceWorker | null>(null);
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").then((registration) => {
      const showWaiting = () => {
        if (registration.waiting && navigator.serviceWorker.controller) setUpdate(registration.waiting);
      };
      const watchInstalling = () =>
        registration.installing?.addEventListener("statechange", showWaiting, { once: true });
      registration.addEventListener("updatefound", watchInstalling);
      watchInstalling();
      showWaiting();
    }).catch((error) => console.error("Service worker registration failed", error));
  }, []);
  const activateUpdate = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.disabled = true;
    // The worker shown may no longer be waiting: another tab or device reloaded first and
    // clients.claim already took this page, or a newer build superseded it. A message to
    // it goes nowhere, so reload directly and let the controlling worker serve the shell.
    if (update?.state !== "installed") { window.location.reload(); return; }
    navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
    update.postMessage({ type: "MEP_ACTIVATE_UPDATE" });
  };
  return (
    <>
      {children}
      {update && (
        <div className="mep-pwa-status" aria-live="polite">
          <div className="mep-pwa-toast" role="status">
            <span>An Enplace update is ready.</span>
            <button type="button" onClick={activateUpdate}>Reload to update</button>
          </div>
        </div>
      )}
    </>
  );
}
