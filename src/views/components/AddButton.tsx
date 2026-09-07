import * as React from "react";

export function AddButton({ label, onClick, expanded = false }: { label: string; onClick: () => void; expanded?: boolean }): React.JSX.Element {
  return <button type="button" className="mep-fab" aria-label={label} title={label} aria-expanded={expanded} onClick={onClick}>+</button>;
}
