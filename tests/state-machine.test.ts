import { describe, expect, it } from "vitest";
import { allowedTransitions, assertTransition, canTransition } from "../src/shared/state-machine";

describe("extension state machine", () => {
  it("allows the complete text-test path", () => {
    const path = ["idle", "preflight", "ready", "running", "completed"] as const;
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index]!, path[index + 1]!)).toBe(true);
    }
  });

  it("allows a verified preflight to recover readiness after an error", () => {
    expect(canTransition("error", "ready")).toBe(true);
    expect(() => assertTransition("error", "ready")).not.toThrow();
  });

  it("rejects contradictory transitions", () => {
    expect(() => assertTransition("idle", "running")).toThrow(/inválida/i);
    expect(allowedTransitions("running")).not.toContain("ready");
    expect(allowedTransitions("error")).not.toContain("running");
  });
});
