/**
 * Config + server-target + host-type resolution.
 *
 * Resolution order: manual override (serverUrl set) > auto-discovered local.
 * A manual override may point at a LOCAL or a REMOTE server — the iframe render
 * path is used for local servers only, while a remote override drives the
 * external-browser path in `openAgentWebUI`. A malformed override is rejected
 * (malformed-url). All decision logic is pure and isolated from the VS Code API
 * behind the `Settings` interface so it is unit-testable without an IDE host.
 * The thin VS Code adapter lives in vscodeSettings.ts.
 */
import type { HealthOutcome } from "../discovery";
import type { ProfileSetting } from "../profiles";

export type HostType = "local" | "remote" | "unknown";

export interface ServerTarget {
  baseUrl: string;
  origin: string;
  hostType: HostType;
  /** Where the target came from, for diagnostics. */
  source: "manual" | "discovered";
}

/**
 * Thin, stubbable settings surface (isolates the vscode API). Carries every
 * `omnigent.*` setting the extension reads; `resolveServerTarget` only needs
 * `serverUrl`, the rest is consumed by the command layer.
 */
export interface Settings {
  serverUrl: string;
  agentConfigPath: string;
  profiles: ProfileSetting[];
  autoOpenUI: boolean;
  uiColumn: "beside" | "active";
  terminalLocation: "editor" | "panel";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Derive the origin (scheme://host[:port]) from a URL. Pure. */
export function originOf(url: string): string {
  const u = new URL(url);
  return u.origin;
}

/** Classify a URL's host as local (loopback) or remote. Pure. */
export function hostTypeOf(url: string): HostType {
  try {
    const u = new URL(url);
    if (LOOPBACK_HOSTS.has(u.hostname)) {
      return "local";
    }
    return "remote";
  } catch {
    return "unknown";
  }
}

/** Build a ServerTarget from a manual override URL. Pure. */
export function manualTarget(serverUrl: string): ServerTarget {
  const trimmed = serverUrl.replace(/\/$/, "");
  return {
    baseUrl: trimmed,
    origin: originOf(trimmed),
    hostType: hostTypeOf(trimmed),
    source: "manual",
  };
}

/** Build a ServerTarget from a discovered local baseUrl. Pure. */
export function discoveredTarget(baseUrl: string): ServerTarget {
  return {
    baseUrl,
    origin: originOf(baseUrl),
    hostType: "local",
    source: "discovered",
  };
}

/** The discovery summary the resolver needs (kept abstract for testability). */
export interface DiscoverySummary {
  found: boolean;
  baseUrl?: string;
  health?: HealthOutcome;
}

export type TargetResolution =
  | { status: "resolved"; target: ServerTarget }
  | {
      status: "needs-prompt";
      reason: "no-manual-no-local" | "local-unhealthy" | "malformed-url";
    };

/**
 * Resolve a server target purely from settings + a discovery summary.
 *  1. manual override (serverUrl non-empty) wins — it may be LOCAL (iframe
 *     pane) or REMOTE (external browser); only a malformed URL is rejected.
 *  2. else auto-discovered local with health === 'ok'
 *  3. else needs-prompt
 */
export function resolveServerTarget(
  settings: Pick<Settings, "serverUrl">,
  discovery: DiscoverySummary,
): TargetResolution {
  const manual = settings.serverUrl?.trim() ?? "";
  if (manual !== "") {
    const hostType = hostTypeOf(manual);
    if (hostType === "unknown") {
      return { status: "needs-prompt", reason: "malformed-url" };
    }
    return { status: "resolved", target: manualTarget(manual) };
  }
  if (discovery.found && discovery.baseUrl) {
    if (discovery.health === "ok") {
      return { status: "resolved", target: discoveredTarget(discovery.baseUrl) };
    }
    return { status: "needs-prompt", reason: "local-unhealthy" };
  }
  return { status: "needs-prompt", reason: "no-manual-no-local" };
}
