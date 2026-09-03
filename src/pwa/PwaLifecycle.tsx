import * as React from "react";

export function PwaLifecycle({ children }: React.PropsWithChildren): React.JSX.Element {
  const [waitingWorker, setWaitingWorker] = React.useState<ServiceWorker | null>(null);
  const reloadRequested = React.useRef(false);

  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let registration: ServiceWorkerRegistration | undefined;
    const watchInstallingWorker = () => {
      const worker = registration?.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) setWaitingWorker(worker);
      });
    };
    const onControllerChange = () => { if (reloadRequested.current) window.location.reload(); };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    void navigator.serviceWorker.register("/sw.js").then((value) => {
      registration = value;
      if (value.waiting) setWaitingWorker(value.waiting);
      value.addEventListener("updatefound", watchInstallingWorker);
      watchInstallingWorker();
    }).catch((error) => console.error("Service worker registration failed", error));
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, []);

  const activateUpdate = () => {
    reloadRequested.current = true;
    waitingWorker?.postMessage({ type: "MEP_ACTIVATE_UPDATE" });
  };

  return (
    <>
      {children}
      {waitingWorker ? (
        <div className="mep-pwa-status" aria-live="polite">
          <div className="mep-pwa-toast" role="status">
            <span>An Enplace update is ready.</span>
            <button type="button" onClick={activateUpdate}>Reload to update</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
