import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { IntegrityBanner } from "./cookbook/IntegrityBanner";
import { PwaLifecycle } from "./pwa/PwaLifecycle";

export function mountApp(): void {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <PwaLifecycle><IntegrityBanner /><AppErrorBoundary><App /></AppErrorBoundary></PwaLifecycle>
  );
}
