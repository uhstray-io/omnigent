# Changelog

All notable changes to the Omnigent VS Code extension are documented here.

## [0.2.0]

Evolves the extension from a single Open command to a 4-command surface, folding
in terminal-launch + profiles + server control from the standalone prototype.

- **Omnigent: Start Server** (`omnigent.startServer`) — launches `omnigent server`
  in a dedicated terminal when no local server is reachable via pidfile + `/health`
  discovery. Idempotent: if a server is already running, it focuses the extension's
  own terminal or toasts the detected URL — never starts a second one.
- **Omnigent: Open Agent Terminal** (`omnigent.openAgentTerminal`) — opens a NEW
  integrated terminal on every invocation running `omnigent run <configPath>
  [extraArgs...]`. Profiles resolve from `omnigent.profiles` (quick-pick when >1)
  or the single `omnigent.agentConfigPath` (direct when 1, error toast when 0).
  Each invocation is tracked by a unique id so repeated clicks open independent
  concurrent terminals (the prototype's name-keyed early-return is fixed).
- **Omnigent: Open Agent WebUI** (`omnigent.openAgentWebUI`, replaces
  `omnigent.open`) — resolves the server URL from discovery or `omnigent.serverUrl`.
  Localhost opens in the editor-beside iframe pane (honoring `omnigent.uiColumn`);
  non-localhost opens in the external browser, since cookie/OIDC flows fail in the
  webview iframe.
- **Omnigent: Stop** (`omnigent.stop`) — quick-pick between stopping the server
  and closing agent terminal(s); acts directly when only one category is active.
  A server the extension started is stopped outright; a shared server the
  extension only discovered warns and requires confirmation before
  `omnigent server stop`.
- A status-bar item reflects server state (stopped / running :PORT); clicking it
  opens a quick-pick of the four commands.
- New settings: `omnigent.agentConfigPath`, `omnigent.profiles`,
  `omnigent.autoOpenUI`, `omnigent.uiColumn`, `omnigent.terminalLocation`.
  `omnigent.serverUrl` now accepts non-localhost URLs (external-browser path).
- `deactivate()` disposes every terminal the extension spawned (server + agents).
- The package script recompiles before packaging (`vscode:prepublish`) so the
  `.vsix` can't ship a stale bundle.

## [0.1.0]

Initial release — a minimal, iframe-only client for a locally running Omnigent
server.

- Open a running local Omnigent server in an editor-beside panel.
- **Omnigent: Open** command, available from the editor-title bar and the
command palette, plus an activity-bar view with an "Open Omnigent" button.
- Automatically discovers a local server via `~/.omnigent/local_server.pid`, or
point the extension at one with the `omnigent.serverUrl` setting. Localhost
servers only in this build.

