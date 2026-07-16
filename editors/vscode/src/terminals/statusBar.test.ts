/**
 * Tests for the status-bar formatting (pure).
 */
import { describe, it, expect } from "vitest";
import { formatStatusBar } from "./statusBar";

describe("formatStatusBar", () => {
  it("shows a stopped indicator with a helpful tooltip", () => {
    const out = formatStatusBar("stopped");
    expect(out.text).toContain("Omnigent");
    expect(out.tooltip.toLowerCase()).toContain("stop");
  });

  it("shows :PORT when running with a known port", () => {
    const out = formatStatusBar("running", 6767);
    expect(out.text).toBe("$(check) Omnigent: :6767");
    expect(out.tooltip).toContain("6767");
  });

  it("shows 'running' without a port for a remote override", () => {
    const out = formatStatusBar("running");
    expect(out.text).toBe("$(check) Omnigent: running");
  });
});
