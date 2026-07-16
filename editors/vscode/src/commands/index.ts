/**
 * Command registration for the 4-command surface (v0.2.0).
 *
 * Each command is a thin delegator into the shared TerminalController; the
 * decision logic lives in pure modules (profiles, config, sessionRegistry,
 * statusBar). Registering them in one place mirrors the v0.1.0
 * `registerOpenPanel(context, controller)` shape, extended to the full set.
 */
import * as vscode from "vscode";
import type { TerminalController } from "../terminals/TerminalController";
import {
  START_SERVER,
  OPEN_AGENT_TERMINAL,
  OPEN_AGENT_WEB_UI,
  STOP,
  SHOW_COMMANDS,
} from "../terminals/TerminalController";

/** Register all commands. Pushes disposables onto context.subscriptions. */
export function registerCommands(
  context: vscode.ExtensionContext,
  controller: TerminalController,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(START_SERVER, () => controller.startServer()),
    vscode.commands.registerCommand(OPEN_AGENT_TERMINAL, () =>
      controller.openAgentTerminal(),
    ),
    vscode.commands.registerCommand(OPEN_AGENT_WEB_UI, () =>
      controller.openAgentWebUI(),
    ),
    vscode.commands.registerCommand(STOP, () => controller.stop()),
    vscode.commands.registerCommand(SHOW_COMMANDS, () => controller.showCommands()),
  );
}
