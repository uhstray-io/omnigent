/**
 * Omnigent VS Code extension entry point.
 *
 * activate() wires the activity-bar tree view, the editor-beside iframe panel,
 * and the TerminalController (server + agent terminals, status bar, the 4
 * commands). Server state is owned by TerminalController.refreshServerState(),
 * called once at activation so the status bar reflects a server that was
 * already running. deactivate() disposes every spawned terminal + the panel.
 */
import * as vscode from "vscode";
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

  panel = new EditorPanelController(context.extensionUri, output);
  controller = new TerminalController(output, panel);
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => controller!.handleTerminalClosed(t)),
  );

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(HOME_VIEW_ID, new HomeTreeProvider()),
  );

  registerCommands(context, controller);

  try {
    await controller.refreshServerState();
  } catch (err) {
    output.appendLine(
      `[omnigent] init error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  output.appendLine("[omnigent] ready");
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
  panel?.dispose();
  panel = undefined;
  output?.appendLine("[omnigent] deactivating");
  output = undefined;
}
