/** Shows a transient notice; App owns the notice list and listens for this event. */
export function notify(message: string): void {
  window.dispatchEvent(new CustomEvent("mep-notice", { detail: { message } }));
}

/** A recipe's file name without folder or extension, the fallback title. */
export const basename = (path: string): string => path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
