/**
 * Agent profile resolution + `omnigent run` argument building (pure).
 *
 * A profile describes how to launch an Omnigent agent in an integrated terminal:
 * a config path plus optional extra CLI args. Profiles come from two settings —
 * `omnigent.profiles` (a list) and `omnigent.agentConfigPath` (a single path
 * used only when no profiles list is set). This module holds no VS Code API so
 * it runs under vitest without an IDE host; the thin adapter is vscodeSettings.
 */

/** Raw profile shape as it appears in `omnigent.profiles`. */
export interface ProfileSetting {
  name?: string;
  configPath: string;
  extraArgs?: string[];
}

/** A resolved, launchable profile (name + extraArgs always present). */
export interface Profile {
  name: string;
  configPath: string;
  extraArgs: string[];
}

/** Normalize a raw settings entry; drops it when it has no configPath. */
function normalize(p: ProfileSetting): Profile | null {
  const configPath = p?.configPath?.trim();
  if (!configPath) {
    return null;
  }
  const name = p.name?.trim() || configPath;
  return { name, configPath, extraArgs: p.extraArgs ?? [] };
}

/**
 * Resolve the effective profile list from settings.
 *  - A non-empty `profiles` array wins; entries without a configPath are
 *    dropped so a misconfigured list surfaces as "no profiles" rather than
 *    silently falling back. Returns the filtered list even when it ends up
 *    empty — the caller then shows a config error toast.
 *  - Otherwise a single `agentConfigPath` yields a one-element "default" list.
 *  - Neither set -> empty.
 */
export function resolveProfiles(
  agentConfigPath: string | undefined,
  profiles: readonly ProfileSetting[] | undefined,
): Profile[] {
  if (profiles && profiles.length > 0) {
    const out: Profile[] = [];
    for (const p of profiles) {
      const n = normalize(p);
      if (n) {
        out.push(n);
      }
    }
    return out;
  }
  const single = agentConfigPath?.trim();
  if (single) {
    return [{ name: "default", configPath: single, extraArgs: [] }];
  }
  return [];
}

/** Build the `omnigent run <config> [extra...]` argv for a profile. Pure. */
export function buildArgs(profile: Profile): string[] {
  return ["run", profile.configPath, ...profile.extraArgs];
}
