import { describe, expect, it } from "vitest";
import { allowedTransitions, assertTransition, canTransition } from "../src/shared/state-machine";

describe("extension state machine", () => {
  it("allows the complete text-test path", () => {
    const path = ["idle", "preflight", "ready", "running", "completed"] as const;
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index]!, path[index + 1]!)).toBe(true);
    }
  });

  it("rejects contradictory transitions", () => {
    expect(() => assertTransition("idle", "running")).toThrow(/inválida/i);
    expect(allowedTransitions("running")).not.toContain("ready");
  });
});
