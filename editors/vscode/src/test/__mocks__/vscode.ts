/**
 * Minimal vscode API stub for vitest unit tests.
 * Only the symbols actually imported by the modules under test need to be here.
 * The pure logic (csp, iframeHtml, host helpers, discovery, config, profiles,
 * sessionRegistry, statusBar) never calls into vscode — only the thin adapters
 * (vscodeSettings, TerminalController) and EditorPanelController do, and the
 * controller test injects a fake panel via createWebviewPanel. This stub exists
 * mainly to satisfy the module resolver; the vscode-heavy paths are kept thin
 * and are not unit-tested.
 */

export interface StatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface Terminal {
  name: string;
  show(): void;
  dispose(): void;
}

export const window = {
  createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  registerTreeDataProvider: (_id: string, _provider: unknown) => ({ dispose: () => {} }),
  onDidCloseTerminal: (_cb: (t: Terminal) => void) => ({ dispose: () => {} }),
  createTerminal: (_opts: unknown) => ({
    name: "stub",
    show: () => {},
    dispose: () => {},
  }),
  createStatusBarItem: (
    _align: unknown,
    _priority: number,
  ): StatusBarItem => ({
    text: "",
    tooltip: undefined,
    command: undefined,
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  // Default stub panel; the controller test overrides this with a fake panel.
  createWebviewPanel: (_id: string, _title: string, _col: unknown, _opts: unknown) => ({
    webview: { html: "", postMessage: () => true, cspSource: "vscode-resource:" },
    reveal: () => {},
    onDidDispose: (_cb: () => void) => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  activeColorTheme: { kind: 2 /* Dark */ },
};

export const workspace = {
  getConfiguration: () => ({ get: (_key: string, def: unknown) => def }),
};

export const env = {
  openExternal: async () => true,
};

export const commands = {
  registerCommand: (_id: string, _fn: unknown) => ({ dispose: () => {} }),
  executeCommand: async () => undefined,
};

export const Uri = {
  parse: (s: string) => ({ toString: () => s, fsPath: s }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
    toString: () => [base.fsPath, ...parts].join("/"),
    fsPath: [base.fsPath, ...parts].join("/"),
  }),
};

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const TerminalLocation = { Panel: 2, Editor: 3 };
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };

export const TreeItem = class {
  label: string;
  collapsibleState: number;
  constructor(label: string, collapsibleState = 0) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
};
