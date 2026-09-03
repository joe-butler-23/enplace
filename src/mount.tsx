import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { PwaLifecycle } from "./pwa/PwaLifecycle";

export function mountApp(): void {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <PwaLifecycle><AppErrorBoundary><App /></AppErrorBoundary></PwaLifecycle>
  );
}
