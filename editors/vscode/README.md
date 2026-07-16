# Omnigent for VS Code

Start an Omnigent server, run agents in integrated terminals, and open the WebUI
— all from VS Code. It is a thin client of the local server's existing HTTP API
(`server/API.md`); there is nothing new to run on the server side.

This is the second donation (tracking
[omnigent-ai/omnigent#1219](https://github.com/omnigent-ai/omnigent/issues/1219)),
folding terminal launch + profiles + server control into the iframe-only 0.1.0
build as a 4-command surface.

## Commands

- **Omnigent: Start Server** (`omnigent.startServer`) — launches `omnigent server`
  in a dedicated integrated terminal when no local server is reachable. If one is
  already running, it focuses the extension's own terminal (when the extension
  started it) or shows an info toast with the detected URL. Idempotent — never
  starts a second server.
- **Omnigent: Open Agent Terminal** (`omnigent.openAgentTerminal`) — opens a NEW
  integrated terminal on every invocation running the agent:
  `omnigent run <configPath> [extraArgs...]`. Placed per `omnigent.terminalLocation`.
  A second click opens a **second, independent** terminal — each invocation is
  tracked by a unique id so concurrent sessions coexist and `Stop` can target
  each one.
- **Omnigent: Open Agent WebUI** (`omnigent.openAgentWebUI`) — resolves the
  server URL from pidfile + `/health` discovery or the `omnigent.serverUrl`
  override. **Localhost** opens in the editor-beside iframe pane (honoring
  `omnigent.uiColumn`); **non-localhost** opens in the **external browser**,
  because cookie/OIDC flows fail in the webview iframe.
- **Omnigent: Stop** (`omnigent.stop`) — quick-pick between **Stop server** and
  **Close agent terminal(s)**; when only one category is active it acts on it
  directly. A server the extension started is stopped outright; a shared server
  the extension only discovered warns (it may back other sessions) and requires
  confirmation before `omnigent server stop`.

All four are in the command palette; **Open Agent Terminal** is also on the
editor-title bar. A status-bar item reflects server state (stopped /
running :PORT) and opens a quick-pick of the commands on click.

## How it works

- On activation the extension discovers a locally running server via
  `~/.omnigent/local_server.pid` and a `/health` probe (or uses
  `omnigent.serverUrl` when set).
- The iframe path is used for **local** servers only — a local server is
  loopback and needs no auth, so no token ever appears in the iframe URL.
- `omnigent.serverUrl` may be localhost **or remote**: a remote URL drives the
  external-browser path (the iframe pane is never used for remote targets).

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `omnigent.agentConfigPath` | `""` | Path passed to `omnigent run <configPath>`. Used only when `omnigent.profiles` is empty. |
| `omnigent.profiles` | `[]` | Agent profiles `{ name, configPath, extraArgs }`; quick-pick when >1. Takes precedence over `agentConfigPath`. |
| `omnigent.serverUrl` | `""` | Manual server URL override (localhost **or** remote). Empty = auto-discover. Remote URLs open in the external browser. |
| `omnigent.autoOpenUI` | `false` | Auto-open the WebUI once a server URL is detected after Start Server / Open Agent Terminal. |
| `omnigent.uiColumn` | `beside` | Where the local WebUI pane opens: `beside` or `active`. |
| `omnigent.terminalLocation` | `editor` | Where agent/server terminals open: `editor` or `panel`. |

## Known limitation

On macOS, VS Code does not deliver `Cmd+A/C/V` keystrokes into a cross-origin iframe
inside a webview, so keyboard paste into the framed app's inputs does not work there.
This is an upstream VS Code issue, not fixable from the extension for the iframe render
path — see microsoft/vscode#129178 and microsoft/vscode#182642. (The on-page copy
buttons and `navigator.clipboard` paths still work.) Remote WebUI targets are
unaffected — they open in the external browser.

## Build / test / package

```bash
npm ci
npm run type-check   # tsc --noEmit
npm run test         # vitest run
npm run build        # esbuild -> dist/extension.js
npm run package      # vsce package -> omnigent-vscode-<version>.vsix
```

The `package` script recompiles before packaging (`vscode:prepublish` chains
`npm run build`), so the `.vsix` can't ship a stale bundle. Install the resulting
`.vsix` via the Extensions view → "Install from VSIX…". The `.vsix` runtime is
`dist/extension.js` + `media/`.

## Layout

```
src/
├── extension.ts                 # activate()/deactivate() — wires discovery + panel + terminals + commands
├── commands/index.ts            # registers the 4 commands + status-bar launcher (thin delegators)
├── terminals/
│   ├── TerminalController.ts     # owns server + agent terminals, status bar, onDidCloseTerminal (vscode-heavy)
│   ├── sessionRegistry.ts        # pure: unique-id session keying for agent terminals
│   └── statusBar.ts              # pure: status-bar text/tooltip formatting
├── profiles.ts                  # pure: agent profile resolution + `omnigent run` argv
├── panel/                        # EditorPanelController, host.ts (render), iframeHtml.ts, csp.ts
├── config/                       # settings + server-target/host-type resolution (local + remote)
└── discovery/                    # local-server discovery (pidfile / health / liveness)
```

Licensed under Apache-2.0 (see `LICENSE`). Contributions require a DCO sign-off
(`git commit -s`), per the repository `CONTRIBUTING.md`.
