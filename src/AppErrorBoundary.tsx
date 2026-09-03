import * as React from "react";

type AppErrorBoundaryState = { error: Error | null };

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
	state: AppErrorBoundaryState = { error: null };
	static getDerivedStateFromError(error: Error): AppErrorBoundaryState { return { error }; }
	componentDidCatch(error: Error): void { console.error("Application render failed", error); }
	render(): React.ReactNode {
		if (!this.state.error) return this.props.children;
		return <main role="alert" aria-labelledby="mep-app-error-title"><h1 id="mep-app-error-title">Enplace could not render this page</h1><p>Saved files remain in your Enplace folder. Unsaved edits may need to be entered again after reload.</p><button type="button" onClick={() => window.location.reload()}>Reload app</button></main>;
	}
}
