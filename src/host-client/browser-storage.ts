import { currentCookbookConnection } from "../cookbook/current";

type StoredFile = { path: string; bytes: Uint8Array };
export type VaultStorageAdapter = {
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  writeNewBytesBatch(entries: ReadonlyArray<readonly [path: string, bytes: Uint8Array]>, existing?: "skip" | "reject"): Promise<number>;
  updateText(path: string, update: (current: string) => string): Promise<string>;
  remove(path: string, recursive?: boolean): Promise<void>;
  walkFiles(): Promise<StoredFile[]>;
};
const decoder = new TextDecoder();
const storage = (): VaultStorageAdapter => {
  const connection = currentCookbookConnection();
  if (!connection) throw new Error("No cookbook connection is active.");
  return connection.adapter;
};
export const readText = async (path: string): Promise<string> => decoder.decode(await storage().readBytes(path));
export const writeNewBytesBatch = (
  entries: ReadonlyArray<readonly [path: string, bytes: Uint8Array]>, existing: "skip" | "reject" = "skip",
): Promise<number> => storage().writeNewBytesBatch(entries, existing);
export const updateText = (path: string, update: (current: string) => string): Promise<string> => storage().updateText(path, update);
export const remove = (path: string, recursive = false): Promise<void> => storage().remove(path, recursive);
