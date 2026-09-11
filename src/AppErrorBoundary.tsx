import * as React from "react";

type AppErrorBoundaryState = { error: Error | null };

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
	state: AppErrorBoundaryState = { error: null };
	static getDerivedStateFromError(error: Error): AppErrorBoundaryState { return { error }; }
	componentDidCatch(error: Error): void { console.error("Application render failed", error); }
	render(): React.ReactNode {
		if (!this.state.error) return this.props.children;
		return <main className="mep-gate" role="alert" aria-labelledby="mep-app-error-title"><section className="mep-gate__card"><h1 id="mep-app-error-title">Enplace could not render this page</h1><p>Your cookbook stays on this device and can be exported from Settings. Unsaved edits may need to be entered again after reload.</p><button type="button" className="mep-button" onClick={() => window.location.reload()}>Reload app</button></section></main>;
	}
}
