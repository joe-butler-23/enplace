export type DiagnosticsState = {
  logFile: string | null;
  log: (message: string, data?: Record<string, unknown>) => void;
  nativeGuard?: {
    begin: () => void;
    success: () => void;
    fail: (reason: string) => void;
  };
};

function noop(): void {}

let state: DiagnosticsState = {
  logFile: null,
  log: noop,
  nativeGuard: undefined
};

export function setDiagnostics(next: Partial<DiagnosticsState>): void {
  state = { ...state, ...next };
}

function getDiagnostics(): DiagnosticsState {
  return state;
}
