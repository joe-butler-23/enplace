import * as React from "react";
import { setIcon } from "@/platform-primitives";

export function Dialog({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}): React.JSX.Element {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useLayoutEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog className="mep-dialog" ref={ref} aria-label={title}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="mep-dialog__body">
      <div className="mep-dialog__header">
        <h2>{title}</h2>
        <button className="mep-icon-button" type="button" onClick={onClose} title={`Close ${title.toLowerCase()}`} ref={(element) => { if (element) setIcon(element, "x"); }} />
      </div>
      {children}
    </div>
  </dialog>;
}
