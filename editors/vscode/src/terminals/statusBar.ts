/**
 * Status-bar text/tooltip formatting for the server-state indicator (pure).
 *
 * The status bar reflects the LOCAL Omnigent server state — stopped, or
 * running with its port. The formatting is isolated from the VS Code API so it
 * can be unit-tested; the thin StatusBarItem adapter lives in TerminalController.
 */

export type ServerState = "stopped" | "running";

export interface StatusBarContent {
  text: string;
  tooltip: string;
}

/**
 * Build the status-bar text + tooltip for a server state. A known port is
 * surfaced as `:PORT`; running without a port (e.g. a remote override) just
 * says "running".
 */
export function formatStatusBar(state: ServerState, port?: number): StatusBarContent {
  if (state === "running") {
    if (port) {
      return {
        text: `$(check) Omnigent: :${port}`,
        tooltip: `Omnigent server running on port ${port}`,
      };
    }
    return { text: "$(check) Omnigent: running", tooltip: "Omnigent server running" };
  }
  return {
    text: "$(circle-slash) Omnigent",
    tooltip: "Omnigent: server stopped. Click to start or open.",
  };
}
