import * as React from "react";

type WeeklyKanbanSurfaceProps = {
	id: string;
	containerRef: React.RefObject<HTMLDivElement | null>;
	className?: string;
};

/** The shared jKanban mount point for vault and focused organiser hosts. */
export function WeeklyKanbanSurface({
	id,
	containerRef,
	className = "weekly-organiser-kanban-host",
}: WeeklyKanbanSurfaceProps): React.JSX.Element {
	return <div id={id} ref={containerRef} className={className} />;
}
