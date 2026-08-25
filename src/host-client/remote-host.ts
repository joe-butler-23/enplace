export type RemoteHostConfig = {
  mode: "remote-host";
  apiBase: string;
  token: string;
  canSelectVault?: boolean;
};

type RemoteHostGlobals = {
  __MEP_REMOTE_HOST__?: Partial<RemoteHostConfig>;
};

function normalizeApiBase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/api";
  return trimmed.replace(/\/+$/, "") || "/api";
}

export function getRemoteHostConfig(): RemoteHostConfig | null {
  const globals = globalThis as RemoteHostGlobals;
  const config = globals.__MEP_REMOTE_HOST__;
  if (!config || config.mode !== "remote-host") {
    return null;
  }

  return {
    mode: "remote-host",
    apiBase: normalizeApiBase(typeof config.apiBase === "string" ? config.apiBase : "/api"),
    token: typeof config.token === "string" ? config.token : "",
    canSelectVault: config.canSelectVault === true
  };
}

export function isRemoteHostRuntime(): boolean {
  return getRemoteHostConfig() !== null;
}

export async function remoteHostJson<T>(
  pathname: string,
  body?: unknown,
  init?: Omit<RequestInit, "body" | "method" | "headers">
): Promise<T> {
  const config = getRemoteHostConfig();
  if (!config) {
    throw new Error("Remote host runtime is not configured.");
  }

  const response = await fetch(`${config.apiBase}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init
  });

  const text = await response.text();
  let payload: any = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.error === "string"
        ? payload.error
        : `Remote host request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

type RemoteWatchStatus = {
  generation: number;
  alive: boolean;
  changed: boolean;
};

type RemoteWatchBatch = {
  generation: number;
  alive: boolean;
  events: unknown[];
};

type SseEvent = {
  event: string;
  data: unknown;
};

function parseSseEvent(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { event, data: JSON.parse(data.join("\n")) };
}

export class RemoteVaultWatchStream {
  private controller: AbortController | null = null;
  private generation = 0;
  private connected = false;

  start(
    generation: number,
    onBatch: (batch: RemoteWatchBatch) => void
  ): Promise<RemoteWatchStatus> {
    this.stop();
    this.generation = generation;
    const controller = new AbortController();
    this.controller = controller;
    return new Promise((resolve, reject) => {
      void this.read(controller, generation, onBatch, resolve, reject);
    });
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async read(
    controller: AbortController,
    generation: number,
    onBatch: (batch: RemoteWatchBatch) => void,
    resolve: (status: RemoteWatchStatus) => void,
    reject: (error: unknown) => void
  ): Promise<void> {
    let settled = false;
    try {
      const config = getRemoteHostConfig();
      if (!config) throw new Error("Remote host runtime is not configured.");
      const response = await fetch(
        `${config.apiBase}/watch?generation=${encodeURIComponent(String(generation))}`,
        {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${config.token}`,
            "Last-Event-ID": String(generation)
          },
          signal: controller.signal
        }
      );
      if (!response.ok || !response.body) {
        throw new Error(`Remote watcher connection failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, boundary);
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length ?? 2;
          buffer = buffer.slice(boundary + separator);
          const event = parseSseEvent(block);
          if (!event) continue;
          if (event.event === "status") {
            const status = event.data as RemoteWatchStatus;
            this.generation = status.generation;
            this.connected = status.alive;
            if (!settled) {
              settled = true;
              resolve(status);
            }
          } else if (event.event === "batch") {
            const batch = event.data as RemoteWatchBatch;
            this.generation = batch.generation;
            onBatch(batch);
          }
        }
        if (done) break;
      }
      if (!controller.signal.aborted) {
        if (!settled) {
          throw new Error("Remote watcher connection closed before reporting status");
        }
        this.connected = false;
        onBatch({ generation: this.generation, alive: false, events: [] });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      this.connected = false;
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        onBatch({ generation: this.generation, alive: false, events: [] });
      }
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}

const remoteVaultWatchStream = new RemoteVaultWatchStream();

export async function startRemoteVaultWatch(
  generation: number,
  onBatch: (batch: RemoteWatchBatch) => void
): Promise<RemoteWatchStatus> {
  await remoteHostJson<RemoteWatchStatus>("/watch/start", { generation });
  return remoteVaultWatchStream.start(generation, onBatch);
}

export function stopRemoteVaultWatch(): void {
  remoteVaultWatchStream.stop();
}

export function isRemoteVaultWatchConnected(): boolean {
  return remoteVaultWatchStream.isConnected();
}

export function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
