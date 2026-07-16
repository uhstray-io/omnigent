/**
 * Owns every terminal the extension spawns + the server-state status bar.
 *
 * Server state is driven by pidfile + /health discovery (or the
 * omnigent.serverUrl override), NOT by which terminals we spawned — so a
 * healthy shared server started outside the extension is still visible to
 * Stop and the status bar. A generation token invalidates in-flight
 * discovery/poll callbacks when a stop, terminal-close, or dispose supersedes
 * them, so a stale poll can't resurrect state for a session that's gone.
 *
 * Thin VS Code adapter: the pure decision logic (profile resolution, arg
 * building, URL/host classification, unique-id session keying, status-bar
 * formatting) lives in src/profiles.ts, src/config/, src/terminals/sessionRegistry.ts
 * and src/terminals/statusBar.ts. This class is exercised via the built
 * extension, not unit-tested.
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
  /**
   * Bumped on every event that invalidates pending async state work (stop,
   * terminal close, dispose, a fresh poll). An in-flight discover()/poll
   * captures the value at start and aborts if it has changed by the time its
   * promise resolves — so a stale poll can't write state for a stopped
   * session, and two near-simultaneous launches can't double-apply.
   */
  private generation = 0;

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
   * already reachable. Idempotent — never starts a second server: if one is
   * running, it focuses the extension's own terminal or toasts the detected
   * URL.
   */
  async startServer(): Promise<void> {
    const gen = this.generation;
    const discovery = await this.discover();
    if (gen !== this.generation) return;
    if (discovery.found && discovery.health === "ok") {
      if (this.serverTerminal) {
        this.serverTerminal.show();
      } else {
        void vscode.window.showInformationMessage(
          `Omnigent server already running at ${discovery.baseUrl}.`,
        );
      }
      this.reflectUrl(discovery.baseUrl);
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
   * Resolve the server URL (override wins, skipping discovery) and open it.
   * Localhost reuses the editor-beside iframe pane; non-localhost opens in
   * the external browser (cookie/OIDC flows fail in the webview iframe).
   */
  async openAgentWebUI(): Promise<void> {
    const gen = this.generation;
    const target = await this.resolveTarget();
    if (gen !== this.generation) {
      return;
    }
    if (!target) {
      void vscode.window.showWarningMessage(
        "Omnigent: no server URL detected yet. Start a server or set omnigent.serverUrl.",
      );
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
   * Quick-pick between stopping the server and closing agent terminal(s). A
   * server is "active" if the extension owns its terminal OR a local pidfile
   * server is healthy — but a pidfile probe is only run when no
   * `omnigent.serverUrl` override is set, so the override wins on Stop too and
   * a remote override never offers to stop an unrelated local server. Stopping
   * a shared (discovered, not extension-owned) server is an explicit, confirmed
   * choice. If only one category is active, act on it directly without the
   * quick-pick.
   */
  async stop(): Promise<void> {
    this.invalidate();
    const gen = this.generation;
    const agentActive = this.agents.size() > 0;
    const discovery = await this.discoverForStop();
    if (gen !== this.generation) {
      return;
    }
    const serverActive =
      this.serverTerminal !== undefined ||
      (discovery.found && discovery.health === "ok");
    if (!serverActive && !agentActive) {
      void vscode.window.showInformationMessage("Omnigent: nothing is running.");
      return;
    }
    if (serverActive && !agentActive) {
      await this.stopServer(discovery);
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
      await this.stopServer(discovery);
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

  // ── server-state refresh (single source of truth) ──────────────────────
  /**
   * Recompute server state from the override (if set, no discovery) or
   * pidfile + /health, and reflect it on the status bar and (for a local
   * target) the editor panel. Called from activation and terminal-close so
   * the status bar never drifts from reality.
   */
  async refreshServerState(): Promise<void> {
    const gen = this.generation;
    const target = await this.resolveTarget();
    if (gen !== this.generation) {
      return;
    }
    if (target) {
      this.reflectUrl(target.baseUrl);
      if (target.hostType === "local") {
        this.panel.setResolved(target);
      }
    } else {
      this.setStatus("stopped");
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
    this.invalidate();
    void this.refreshServerState();
  }

  /** Dispose every terminal the extension spawned + the status bar. */
  dispose(): void {
    this.invalidate();
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
   * Stop a server. One the extension started is closed outright (no modal); a
   * shared server the extension only discovered warns (it may back other
   * sessions) and requires confirmation before `omnigent server stop` tears
   * it down. The execFile callback is generation-gated so a stop superseded by
   * a newer launch, a dispose, or a terminal close can't write state.
   */
  private async stopServer(discovery?: LocalDiscovery): Promise<void> {
    if (this.serverTerminal) {
      this.serverTerminal.dispose();
      this.serverTerminal = undefined;
      this.invalidate();
      void this.refreshServerState();
      return;
    }
    const d = discovery ?? (await this.discoverForStop());
    if (!d.found) {
      void vscode.window.showInformationMessage(
        "Omnigent: no running server found.",
      );
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Omnigent server at ${d.baseUrl} was already running when the extension found it — stopping it may affect other sessions. Stop it anyway?`,
      { modal: true },
      "Stop",
    );
    if (confirm !== "Stop") {
      return;
    }
    const gen = this.generation;
    execFile(
      "omnigent",
      ["server", "stop"],
      { timeout: SERVER_STOP_TIMEOUT_MS },
      (err) => {
        if (gen !== this.generation) {
          return;
        }
        if (err) {
          this.output.appendLine(
            `[omnigent] server stop failed: ${err.message}`,
          );
          void vscode.window.showErrorMessage(
            "Omnigent: failed to stop the server.",
          );
          return;
        }
        this.invalidate();
        void this.refreshServerState();
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

  /**
   * Discovery for the Stop path. When `omnigent.serverUrl` is set the override
   * is the server target — there is no local pidfile server to stop via
   * `omnigent server stop` — so this skips the pidfile probe and returns
   * not-found. Only an extension-owned terminal or a real local discovery can
   * make Stop offer the server choice.
   */
  private async discoverForStop(): Promise<LocalDiscovery> {
    if (readSettings().serverUrl.trim() !== "") {
      return { found: false, reason: "no-pidfile" };
    }
    return this.discover();
  }

  /**
   * Resolve the server target. A non-empty `omnigent.serverUrl` override wins
   * and skips pidfile/health discovery entirely; otherwise discovery decides.
   */
  private async resolveTarget(): Promise<ServerTarget | undefined> {
    const settings = readSettings();
    if (settings.serverUrl.trim() !== "") {
      const r = resolveServerTarget(settings, { found: false });
      return r.status === "resolved" ? r.target : undefined;
    }
    const discovery = await this.discover();
    const r = resolveServerTarget(settings, {
      found: discovery.found,
      baseUrl: discovery.found ? discovery.baseUrl : undefined,
      health: discovery.found ? discovery.health : undefined,
    });
    return r.status === "resolved" ? r.target : undefined;
  }

  /**
   * Poll pidfile/health discovery until a server surfaces, then reflect its
   * URL on the status bar and (when omnigent.autoOpenUI is set) open the
   * WebUI. Cancels any prior poll first; the captured generation gates every
   * state write so a poll superseded by a stop or a newer launch is ignored.
   */
  private pollUntilReady(): void {
    this.invalidate();
    const gen = this.generation;
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
        if (gen !== this.generation) {
          return;
        }
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

  /** Cancel the poll timer and invalidate in-flight discovery callbacks. */
  private invalidate(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.generation++;
  }

  private setStatus(state: ServerState, port?: number): void {
    const c = formatStatusBar(state, port);
    this.statusBarItem.text = c.text;
    this.statusBarItem.tooltip = c.tooltip;
  }
}
