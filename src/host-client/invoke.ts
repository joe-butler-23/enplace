import {
  isRemoteHostRuntime,
  isRemoteVaultWatchConnected,
  remoteHostJson,
  startRemoteVaultWatch,
  stopRemoteVaultWatch
} from "./remote-host";

export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isRemoteHostRuntime()) {
    if (cmd === "mep_watch_vault") {
      const channel = args?.onEvent as Channel<unknown> | undefined;
      return startRemoteVaultWatch(
        typeof args?.generation === "number" ? args.generation : 0,
        (batch) => channel?.onmessage?.(batch)
      ) as Promise<T>;
    }
    if (cmd === "mep_unwatch_vault") {
      stopRemoteVaultWatch();
      return undefined as T;
    }
    if (cmd === "mep_vault_changes_since") {
      const status = await remoteHostJson<{
        generation: number;
        alive: boolean;
        changed: boolean;
      }>("/watch/status", {
        generation: typeof args?.generation === "number" ? args.generation : 0
      });
      return {
        ...status,
        alive: status.alive && isRemoteVaultWatchConnected()
      } as T;
    }
    const result = await remoteHostJson<T | { events?: unknown[] }>("/invoke", {
      cmd,
      args: args ?? {}
    });
    if (
      cmd === "mep_recipe_database_stream" &&
      result &&
      typeof result === "object" &&
      Array.isArray((result as { events?: unknown[] }).events)
    ) {
      const channel = args?.onEvent as Channel<unknown> | undefined;
      for (const event of (result as { events: unknown[] }).events) {
        channel?.onmessage?.(event);
      }
      return undefined as T;
    }
    return result as T;
  }
  const fixtureRuntime = (globalThis as { __MEP_SHIM_FIXTURE_ID__?: unknown }).__MEP_SHIM_FIXTURE_ID__ === "visual-v1";
  if (fixtureRuntime && cmd === "mep_get_thumbnail" && typeof args?.path === "string") {
    return args.path as T;
  }
  if (fixtureRuntime && cmd === "mep_get_thumbnails" && Array.isArray(args?.paths)) {
    return args.paths.map((entry) => typeof entry === "string" ? entry : null) as T;
  }
  if (fixtureRuntime && cmd === "mep_prepare_database_thumbnails" && Array.isArray(args?.paths)) {
    return args.paths.map((entry) => typeof entry === "string" ? entry : null) as T;
  }
  throw new Error("The mep host API requires the web host runtime.");
}

export class Channel<T = unknown> {
  onmessage: ((message: T) => void) | null = null;
  
  constructor(onmessage?: (message: T) => void) {
    if (onmessage) this.onmessage = onmessage;
  }
  
  toJSON(): string {
    return "__CHANNEL__";
  }
}
