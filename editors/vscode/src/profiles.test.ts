/**
 * Tests for agent profile resolution + `omnigent run` argv building (pure).
 */
import { describe, it, expect } from "vitest";
import { resolveProfiles, buildArgs, type ProfileSetting } from "./profiles";

describe("resolveProfiles", () => {
  it("returns [] when neither profiles nor agentConfigPath is set", () => {
    expect(resolveProfiles(undefined, undefined)).toEqual([]);
    expect(resolveProfiles("", [])).toEqual([]);
  });

  it("synthesizes a single 'default' profile from agentConfigPath", () => {
    expect(resolveProfiles("/agents/researcher.yaml", undefined)).toEqual([
      { name: "default", configPath: "/agents/researcher.yaml", extraArgs: [] },
    ]);
  });

  it("trims whitespace on agentConfigPath", () => {
    expect(resolveProfiles("  /agents/x.yaml  ", undefined)).toEqual([
      { name: "default", configPath: "/agents/x.yaml", extraArgs: [] },
    ]);
  });

  it("uses the profiles list when present (many)", () => {
    const profiles: ProfileSetting[] = [
      { name: "researcher", configPath: "/a.yaml", extraArgs: ["--model", "gpt"] },
      { name: "reviewer", configPath: "/b.yaml" },
    ];
    expect(resolveProfiles("/ignored.yaml", profiles)).toEqual([
      { name: "researcher", configPath: "/a.yaml", extraArgs: ["--model", "gpt"] },
      { name: "reviewer", configPath: "/b.yaml", extraArgs: [] },
    ]);
  });

  it("falls back to configPath for entries missing a name", () => {
    const profiles: ProfileSetting[] = [{ configPath: "/c.yaml" }];
    expect(resolveProfiles(undefined, profiles)).toEqual([
      { name: "/c.yaml", configPath: "/c.yaml", extraArgs: [] },
    ]);
  });

  it("drops profile entries without a configPath and surfaces the misconfig as empty", () => {
    // Real settings JSON can omit configPath; reflect that by widening the
    // literal so the drop-path is exercised (resolveProfiles tolerates it).
    const profiles = [
      { name: "bad" },
      { name: "also-bad", configPath: "   " },
    ] as unknown as ProfileSetting[];
    // A non-empty list that filters to nothing stays empty (no silent fallback
    // to agentConfigPath) so the caller can show a config error toast.
    expect(resolveProfiles("/fallback.yaml", profiles)).toEqual([]);
  });
});

describe("buildArgs", () => {
  it("builds `omnigent run <config>` with no extra args", () => {
    expect(buildArgs({ name: "x", configPath: "/a.yaml", extraArgs: [] })).toEqual([
      "run",
      "/a.yaml",
    ]);
  });

  it("appends extra args after the config path", () => {
    expect(
      buildArgs({ name: "x", configPath: "/a.yaml", extraArgs: ["--model", "gpt", "--resume"] }),
    ).toEqual(["run", "/a.yaml", "--model", "gpt", "--resume"]);
  });
});
