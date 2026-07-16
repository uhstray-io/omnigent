/**
 * Owns every terminal the extension spawns + the server-state status bar.
 *
 * Thin VS Code adapter: the pure decision logic (profile resolution, arg
 * building, URL/host classification, unique-id session keying, status-bar
 * formatting) lives in src/profiles.ts, src/config/, src/terminals/sessionRegistry.ts
 * and src/terminals/statusBar.ts — this class wires those to the vscode API
 * (createTerminal / showQuickPick / status bar / onDidCloseTerminal / execFile)
 * and is therefore not unit-tested; it is exercised via the built extension.
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import {
  discoverLocalServer,
  DEFAULT_HEALTH_TIMEOUT_MS,
  type LocalDiscovery,
} from "../discovery";
import { resolveServerTarget, type ServerTarget } from "../config";
import { readSettings } from "../config/vscodeSettings";
import { resolveProfiles, buildArgs, type Profile } from "../profiles";
import { SessionRegistry } from "./sessionRegistry";
import { formatStatusBar, type ServerState } from "./statusBar";
import type { EditorPanelController } from "../panel/EditorPanelController";

const SERVER_TERMINAL_NAME = "Omnigent Server";
const POLL_INTERVAL_MS = 1000;
const POLL_MAX_ATTEMPTS = 30;
const SERVER_STOP_TIMEOUT_MS = 10_000;

// Command ids (mirrored in package.json contributes.commands). `showCommands`
// is an internal launcher wired to the status-bar click, not in the palette.
export const START_SERVER = "omnigent.startServer";
export const OPEN_AGENT_TERMINAL = "omnigent.openAgentTerminal";
export const OPEN_AGENT_WEB_UI = "omnigent.openAgentWebUI";
export const STOP = "omnigent.stop";
export const SHOW_COMMANDS = "omnigent.showCommands";

export class TerminalController {
  private serverTerminal?: vscode.Terminal;
  private readonly agents = new SessionRegistry<Profile, vscode.Terminal>();
  private readonly statusBarItem: vscode.StatusBarItem;
  private pollTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly panel: EditorPanelController,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBarItem.command = SHOW_COMMANDS;
    this.setStatus("stopped");
    this.statusBarItem.show();
  }

  // ── omnigent.startServer ───────────────────────────────────────────────
  /**
   * Launch `omnigent server` in a dedicated terminal unless a local server is
   * already reachable. Idempotent — never starts a second server: if the
   * extension owns the running server's terminal it focuses it, otherwise it
   * toasts the detected URL.
   */
  async startServer(): Promise<void> {
    const discovery = await this.discover();
    if (discovery.found && discovery.health === "ok") {
      if (this.serverTerminal) {
        this.serverTerminal.show();
      } else {
        void vscode.window.showInformationMessage(
          `Omnigent server already running at ${discovery.baseUrl}.`,
        );
      }
      this.setStatus("running", discovery.port);
      return;
    }
    if (this.serverTerminal) {
      this.serverTerminal.show();
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: SERVER_TERMINAL_NAME,
      location: vscode.TerminalLocation.Editor,
      shellPath: "omnigent",
      shellArgs: ["server"],
    });
    this.serverTerminal = terminal;
    terminal.show();
    this.output.appendLine("[omnigent] started server terminal");
    this.setStatus("running");
    this.pollUntilReady();
  }

  // ── omnigent.openAgentTerminal ─────────────────────────────────────────
  /**
   * Open a NEW integrated terminal on every invocation running the agent:
   * `omnigent run <configPath> [extraArgs...]`. Sessions are keyed by a unique
   * id so repeated clicks open independent concurrent terminals.
   */
  async openAgentTerminal(): Promise<void> {
    const settings = readSettings();
    const profiles = resolveProfiles(settings.agentConfigPath, settings.profiles);
    if (profiles.length === 0) {
      void vscode.window.showErrorMessage(
        "Omnigent: no agent profile configured. Set omnigent.agentConfigPath or omnigent.profiles.",
      );
      return;
    }
    const profile = await this.pickProfile(profiles);
    if (!profile) {
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: `Omnigent: ${profile.name}`,
      location:
        settings.terminalLocation === "panel"
          ? vscode.TerminalLocation.Panel
          : vscode.TerminalLocation.Editor,
      shellPath: "omnigent",
      shellArgs: buildArgs(profile),
    });
    const id = this.agents.register(profile, terminal);
    terminal.show();
    this.output.appendLine(
      `[omnigent] spawned agent terminal #${id} (${profile.name})`,
    );
    this.pollUntilReady();
  }

  // ── omnigent.openAgentWebUI ───────────────────────────────────────────
  /**
   * Resolve the server URL from discovery or the `omnigent.serverUrl`
   * override. Localhost reuses the editor-beside iframe pane; non-localhost
   * opens in the external browser (cookie/OIDC flows fail in the webview
   * iframe).
   */
  async openAgentWebUI(): Promise<void> {
    const target = await this.resolveWebUiTarget();
    if (!target) {
      return;
    }
    if (target.hostType === "local") {
      this.panel.setResolved(target);
      const settings = readSettings();
      this.panel.ensure(
        settings.uiColumn === "active"
          ? vscode.ViewColumn.Active
          : vscode.ViewColumn.Beside,
      );
    } else {
      await vscode.env.openExternal(vscode.Uri.parse(target.baseUrl));
    }
  }

  // ── omnigent.stop ──────────────────────────────────────────────────────
  /**
   * Quick-pick between stopping the server and closing agent terminal(s). If
   * only one category is active, act on it directly without the quick-pick.
   */
  async stop(): Promise<void> {
    const serverActive = this.serverTerminal !== undefined;
    const agentActive = this.agents.size() > 0;
    if (!serverActive && !agentActive) {
      void vscode.window.showInformationMessage("Omnigent: nothing is running.");
      return;
    }
    if (serverActive && !agentActive) {
      await this.stopServer();
      return;
    }
    if (agentActive && !serverActive) {
      await this.closeAgentTerminals();
      return;
    }
    const choice = await vscode.window.showQuickPick(
      ["Stop server", "Close agent terminal(s)"],
      { placeHolder: "Stop what?" },
    );
    if (choice === "Stop server") {
      await this.stopServer();
    } else if (choice === "Close agent terminal(s)") {
      await this.closeAgentTerminals();
    }
  }

  // ── omnigent.showCommands (status-bar click) ──────────────────────────
  async showCommands(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(debug-start) Start Server", command: START_SERVER },
        { label: "$(terminal) Open Agent Terminal", command: OPEN_AGENT_TERMINAL },
        { label: "$(browser) Open Agent WebUI", command: OPEN_AGENT_WEB_UI },
        { label: "$(debug-stop) Stop", command: STOP },
      ],
      { placeHolder: "Omnigent" },
    );
    if (pick) {
      await vscode.commands.executeCommand(pick.command);
    }
  }

  // ── terminal lifecycle ─────────────────────────────────────────────────
  /** Clean up tracking when a spawned terminal closes (onDidCloseTerminal). */
  handleTerminalClosed(terminal: vscode.Terminal): void {
    if (this.serverTerminal === terminal) {
      this.serverTerminal = undefined;
    }
    const id = this.agents.idOf(terminal);
    if (id !== undefined) {
      this.agents.delete(id);
    }
    this.recomputeStatus();
  }

  /** Dispose every terminal the extension spawned + the status bar. */
  dispose(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.serverTerminal?.dispose();
    this.serverTerminal = undefined;
    for (const s of this.agents.values()) {
      s.terminal.dispose();
    }
    this.agents.clear();
    this.statusBarItem.dispose();
  }

  // ── internals ─────────────────────────────────────────────────────────
  /**
   * Stop a server. Only a server the extension started is stopped without
   * confirmation; a server the extension merely discovered is shared (it may
   * back other sessions) and requires the user to confirm before
   * `omnigent server stop` tears it down.
   */
  private async stopServer(): Promise<void> {
    if (this.serverTerminal) {
      this.serverTerminal.dispose();
      this.serverTerminal = undefined;
      this.recomputeStatus();
      return;
    }
    const discovery = await this.discover();
    if (!discovery.found) {
      void vscode.window.showInformationMessage(
        "Omnigent: no running server found.",
      );
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Omnigent server at ${discovery.baseUrl} was already running when the extension found it — stopping it may affect other sessions. Stop it anyway?`,
      { modal: true },
      "Stop",
    );
    if (confirm !== "Stop") {
      return;
    }
    execFile(
      "omnigent",
      ["server", "stop"],
      { timeout: SERVER_STOP_TIMEOUT_MS },
      (err) => {
        if (err) {
          this.output.appendLine(
            `[omnigent] server stop failed: ${err.message}`,
          );
          void vscode.window.showErrorMessage(
            "Omnigent: failed to stop the server.",
          );
          return;
        }
        this.recomputeStatus();
      },
    );
  }

  /**
   * Dispose extension-spawned agent terminals. One terminal is closed
   * directly; several offer a multi-pick (cancel keeps them all).
   */
  private async closeAgentTerminals(): Promise<void> {
    const sessions = this.agents.values();
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage(
        "Omnigent: no agent terminals to close.",
      );
      return;
    }
    if (sessions.length === 1) {
      const s = sessions[0];
      s.terminal.dispose();
      this.agents.delete(s.id);
      return;
    }
    const picks = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.profile.name,
        description: `#${s.id}`,
        picked: false,
        id: s.id,
      })),
      { canPickMany: true, placeHolder: "Close which agent terminals?" },
    );
    if (!picks || picks.length === 0) {
      return;
    }
    for (const p of picks) {
      const s = this.agents.get(p.id);
      if (s) {
        s.terminal.dispose();
        this.agents.delete(p.id);
      }
    }
  }

  private async pickProfile(profiles: Profile[]): Promise<Profile | undefined> {
    if (profiles.length === 1) {
      return profiles[0];
    }
    const pick = await vscode.window.showQuickPick(
      profiles.map((p) => ({
        label: p.name,
        description: p.configPath,
        profile: p,
      })),
      { placeHolder: "Select an Omnigent agent profile to run" },
    );
    return pick?.profile;
  }

  private async discover(): Promise<LocalDiscovery> {
    return discoverLocalServer(undefined, DEFAULT_HEALTH_TIMEOUT_MS);
  }

  private async resolveWebUiTarget(): Promise<ServerTarget | undefined> {
    const settings = readSettings();
    const discovery = await this.discover();
    const resolution = resolveServerTarget(settings, {
      found: discovery.found,
      baseUrl: discovery.found ? discovery.baseUrl : undefined,
      health: discovery.found ? discovery.health : undefined,
    });
    if (resolution.status === "resolved") {
      return resolution.target;
    }
    void vscode.window.showWarningMessage(
      "Omnigent: no server URL detected yet. Start a server or set omnigent.serverUrl.",
    );
    return undefined;
  }

  /**
   * Poll pidfile/health discovery until a server surfaces, then reflect its
   * URL on the status bar and (when omnigent.autoOpenUI is set) open the WebUI.
   * An explicit omnigent.serverUrl override short-circuits the poll. At most
   * one poll runs at a time so concurrent launches share a single watcher.
   */
  private pollUntilReady(): void {
    if (this.pollTimer) {
      return;
    }
    const override = readSettings().serverUrl.trim();
    if (override) {
      this.reflectUrl(override);
      if (readSettings().autoOpenUI) {
        void this.openAgentWebUI();
      }
      return;
    }
    let attempts = 0;
    const poll = (): void => {
      void this.discover().then((discovery) => {
        if (discovery.found && discovery.health === "ok") {
          this.pollTimer = undefined;
          this.reflectUrl(discovery.baseUrl);
          if (readSettings().autoOpenUI) {
            void this.openAgentWebUI();
          }
          return;
        }
        attempts++;
        if (attempts < POLL_MAX_ATTEMPTS) {
          this.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
        } else {
          this.pollTimer = undefined;
        }
      });
    };
    poll();
  }

  /** Surface a known-good server URL on the status bar. */
  private reflectUrl(baseUrl: string): void {
    let port: number | undefined;
    try {
      const raw = new URL(baseUrl).port;
      port = raw ? Number(raw) : undefined;
    } catch {
      port = undefined;
    }
    this.setStatus("running", port);
    this.output.appendLine(`[omnigent] server URL: ${baseUrl}`);
  }

  private recomputeStatus(): void {
    if (this.serverTerminal) {
      this.setStatus("running");
      return;
    }
    const override = readSettings().serverUrl.trim();
    if (override) {
      this.reflectUrl(override);
      return;
    }
    this.setStatus("stopped");
  }

  private setStatus(state: ServerState, port?: number): void {
    const c = formatStatusBar(state, port);
    this.statusBarItem.text = c.text;
    this.statusBarItem.tooltip = c.tooltip;
  }
}
