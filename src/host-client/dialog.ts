import { registerMountedVaultDirectory } from "./fs";
import { getRemoteHostConfig } from "./remote-host";

type PickerGlobals = {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<unknown>;
  prompt?: (message?: string) => string | null;
};

export async function open(
  options?: { directory?: boolean; multiple?: boolean }
): Promise<string | string[] | null> {
  const globals = globalThis as PickerGlobals;

  if (getRemoteHostConfig() && options?.directory) {
    console.warn("Vault selection is managed by the host server in remote-host mode.");
    return null;
  }

  if (options?.directory && typeof globals.showDirectoryPicker === "function") {
    const handle = await globals.showDirectoryPicker({ mode: "readwrite" });
    return registerMountedVaultDirectory(handle as Parameters<typeof registerMountedVaultDirectory>[0]);
  }

  if (typeof globals.prompt === "function") {
    const path = globals.prompt("Enter path (shim):");
    return path || null;
  }

  return null;
}
