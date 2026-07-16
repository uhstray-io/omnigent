/**
 * Omnigent VS Code extension entry point (4-command build, v0.2.0).
 *
 * activate() wires:
 *  - Config / local-server discovery
 *  - A minimal activity-bar tree view whose welcome content offers Start
 *    Server / Open Agent Terminal / Open Agent WebUI
 *  - EditorPanelController: the editor-beside iframe surface (local WebUI)
 *  - TerminalController: every terminal the extension spawns + the server-state
 *    status bar; hosts the 4 commands (startServer / openAgentTerminal /
 *    openAgentWebUI / stop) and the internal status-bar launcher
 *
 * deactivate() disposes every terminal the extension spawned (server + agents)
 * and the editor panel.
 */
import * as vscode from "vscode";
import { discoverLocalServer, DEFAULT_HEALTH_TIMEOUT_MS } from "./discovery";
import { resolveServerTarget } from "./config";
import { readSettings } from "./config/vscodeSettings";
import { EditorPanelController } from "./panel/EditorPanelController";
import { TerminalController } from "./terminals/TerminalController";
import { registerCommands } from "./commands";

/** Id of the minimal activity-bar view (declared in package.json contributes.views). */
const HOME_VIEW_ID = "omnigent.home";

let output: vscode.OutputChannel | undefined;
let panel: EditorPanelController | undefined;
let controller: TerminalController | undefined;

/**
 * A no-op tree provider. A `viewsContainer` only renders its activity-bar icon
 * when it has at least one registered view; this provides that view. The actual
 * call-to-action is the `viewsWelcome` content in package.json.
 */
class HomeTreeProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(element: never): vscode.TreeItem {
    return element;
  }
  getChildren(): never[] {
    return [];
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Omnigent");
  context.subscriptions.push(output);
  output.appendLine("[omnigent] activating");

  // ── Editor-beside iframe surface (local WebUI) ──────────────────────────
  panel = new EditorPanelController(context.extensionUri, output);

  // ── Terminal + status-bar controller ─────────────────────────────────────
  controller = new TerminalController(output, panel);
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => controller!.handleTerminalClosed(t)),
  );

  // ── Minimal activity-bar view (makes the container icon render) ──────────
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(HOME_VIEW_ID, new HomeTreeProvider()),
  );

  // ── Commands ────────────────────────────────────────────────────────────
  registerCommands(context, controller);

  // ── Resolve the local server at activation ──────────────────────────────
  try {
    const settings = readSettings();
    const discovery = await discoverLocalServer(undefined, DEFAULT_HEALTH_TIMEOUT_MS);
    const resolution = resolveServerTarget(settings, {
      found: discovery.found,
      baseUrl: discovery.found ? discovery.baseUrl : undefined,
      health: discovery.found ? discovery.health : undefined,
    });

    if (resolution.status === "resolved") {
      const target = resolution.target;
      panel.setResolved(target);
      output.appendLine(
        `[omnigent] target: ${target.baseUrl} (hostType=${target.hostType}, source=${target.source})`,
      );
    } else {
      output.appendLine(
        `[omnigent] no local server (${resolution.reason}); run 'Omnigent: Start Server' or set omnigent.serverUrl`,
      );
    }
  } catch (err) {
    output.appendLine(
      `[omnigent] init error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  output.appendLine("[omnigent] ready");
}

export function deactivate(): void {
  // Dispose every terminal the extension spawned (server + agents).
  controller?.dispose();
  controller = undefined;
  panel?.dispose();
  panel = undefined;
  output?.appendLine("[omnigent] deactivating");
  output = undefined;
}
