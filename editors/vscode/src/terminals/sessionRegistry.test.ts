/**
 * Tests for SessionRegistry — the unique-id keying that lets repeated
 * `omnigent.openAgentTerminal` invocations spawn independent concurrent
 * terminals even for the same profile.
 */
import { describe, it, expect } from "vitest";
import { SessionRegistry } from "./sessionRegistry";
import type { Profile } from "../profiles";

const PROF: Profile = { name: "researcher", configPath: "/a.yaml", extraArgs: [] };

describe("SessionRegistry", () => {
  it("assigns distinct ids to two opens of the SAME profile", () => {
    const reg = new SessionRegistry<Profile, { tag: string }>();
    const id1 = reg.register(PROF, { tag: "t1" });
    const id2 = reg.register(PROF, { tag: "t2" });

    expect(id1).not.toBe(id2);
    expect(reg.size()).toBe(2);
    expect(reg.get(id1)?.terminal.tag).toBe("t1");
    expect(reg.get(id2)?.terminal.tag).toBe("t2");
  });

  it("stopping one session leaves the other intact", () => {
    const reg = new SessionRegistry<Profile, { tag: string }>();
    const id1 = reg.register(PROF, { tag: "t1" });
    const id2 = reg.register(PROF, { tag: "t2" });

    expect(reg.delete(id1)).toBe(true);
    expect(reg.size()).toBe(1);
    expect(reg.get(id1)).toBeUndefined();
    expect(reg.get(id2)?.terminal.tag).toBe("t2");
  });

  it("deleting an unknown id is a no-op", () => {
    const reg = new SessionRegistry<Profile, unknown>();
    expect(reg.delete(999)).toBe(false);
    expect(reg.size()).toBe(0);
  });

  it("idOf locates a session by terminal identity (for onDidCloseTerminal)", () => {
    const reg = new SessionRegistry<Profile, { tag: string }>();
    const t1 = { tag: "t1" };
    const id1 = reg.register(PROF, t1);
    expect(reg.idOf(t1)).toBe(id1);
    expect(reg.idOf({ tag: "other" })).toBeUndefined();
  });

  it("clear disposes all tracked sessions", () => {
    const reg = new SessionRegistry<Profile, unknown>();
    reg.register(PROF, {});
    reg.register(PROF, {});
    reg.clear();
    expect(reg.size()).toBe(0);
  });
});
