/** A receipt covers every update sent before its request on the same WebSocket.
 * It contains only a random request nonce; cookbook keys and plaintext never enter this protocol.
 */
export const MESSAGE_COMMIT = 4;
export type CommitStatus = "request" | "committed" | "rejected";
const statuses: CommitStatus[] = ["request", "committed", "rejected"];

export function commitFrame(id: string, status: CommitStatus): Uint8Array {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid cookbook commit nonce.");
  const frame = new Uint8Array(18);
  frame[0] = MESSAGE_COMMIT;
  frame[1] = statuses.indexOf(status);
  for (let index = 0; index < 16; index += 1) frame[index + 2] = Number.parseInt(id.slice(index * 2, index * 2 + 2), 16);
  return frame;
}

export function readCommitFrame(frame: Uint8Array): { id: string; status: CommitStatus } | null {
  if (frame.byteLength !== 18 || frame[0] !== MESSAGE_COMMIT || !statuses[frame[1]]) return null;
  return {
    id: Array.from(frame.subarray(2), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    status: statuses[frame[1]],
  };
}
