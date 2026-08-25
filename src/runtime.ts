type RuntimeGlobals = {
  __MEP_REMOTE_HOST__?: unknown;
};

/**
 * True when the app is served by the web host with its API configuration
 * injected. This is the only supported runtime: all mep_* commands and
 * filesystem access go through the host HTTP API.
 */
export function isHostedRuntime(): boolean {
  return typeof (globalThis as RuntimeGlobals).__MEP_REMOTE_HOST__ !== "undefined";
}
