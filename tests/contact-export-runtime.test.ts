import { describe, expect, it } from "vitest";
import { emptyContactExportState } from "../src/contact-export/contact-export-store";

describe("contact export state", () => {
  it("starts empty and stores no persistent contact data or stale metrics by default", () => {
    const state = emptyContactExportState(new Date("2026-08-28T20:00:00.000Z"));
    expect(state.status).toBe("idle");
    expect(state.contacts).toEqual([]);
    expect(state.problems).toEqual([]);
    expect(state.metrics).toBeNull();
    expect(state.labelResults).toEqual([]);
    expect(state.diagnostic.status).toBe("unknown");
    expect(state.diagnostic.reportedCount).toBeNull();
    expect(state.diagnostic.collectedUniqueContacts).toBeNull();
  });
});
