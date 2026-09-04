import * as React from "react";
import type { MergeResult } from "@/cookbook/merge";
import { RecipeView, type RecipeViewHandle } from "./RecipeView";

class PreviewErrorBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(error: unknown): void { console.error("Preview render failed", error); }
  render(): React.ReactNode { return this.state.failed ? this.props.fallback : this.props.children; }
}
const basename = (path: string): string => path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
export type PreviewPaneProps = {
  path: string | null; content: string; isRecipe: boolean; width: number;
  recipeRef: React.RefObject<RecipeViewHandle | null>;
  onClose: () => void; onWidth: (width: number) => void;
  onSave: (baseContent: string, nextContent: string) => Promise<MergeResult>; resolveImage: (path: string, source: string) => string | null;
};
export function PreviewPane(props: PreviewPaneProps): React.JSX.Element {
  const { path, content, isRecipe, width, recipeRef, onClose, onWidth, onSave, resolveImage } = props;
  const drag = React.useRef<{ x: number; width: number } | null>(null);
  React.useEffect(() => {
    const move = (event: MouseEvent) => { if (drag.current) onWidth(Math.max(320, Math.min(760, drag.current.width + drag.current.x - event.clientX))); };
    const up = () => { drag.current = null; };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [onWidth]);
  const raw = <div className="mep-preview__content"><pre>{content || (path ? `# ${basename(path)}` : "")}</pre></div>;
  return <aside className="mep-preview" data-preview-path={path ?? ""}>
    <div className="mep-preview__resizer" role="separator" aria-label="Resize side pane" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={760} aria-valuenow={width} tabIndex={0}
      onMouseDown={(event) => { event.preventDefault(); drag.current = { x: event.clientX, width }; }}
      onKeyDown={(event) => { const delta = event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0; if (delta) { event.preventDefault(); onWidth(Math.max(320, Math.min(760, width + delta))); } }} />
    <div className="mep-preview__header-row"><button type="button" className="mep-preview__close" onClick={onClose}>x</button></div>
    {!path ? <div className="mep-preview__empty">Open a card to see the note.</div> : content === "Failed to load file." ? <div className="mep-preview__empty">Failed to load file.</div> : !isRecipe ? raw :
      <PreviewErrorBoundary key={`${path}:${content}`} fallback={<div className="mep-preview__content"><div className="mep-preview__empty">Could not render this note preview. Showing raw markdown.</div>{raw}</div>}>
        <div className="mep-preview__content"><RecipeView key={path} ref={recipeRef} path={path} title={basename(path)} content={content} mode="rendered" onSave={onSave} resolveImage={resolveImage} /></div>
      </PreviewErrorBoundary>}
  </aside>;
}
