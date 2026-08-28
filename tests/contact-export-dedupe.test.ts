import { describe, expect, it } from "vitest";
import { deduplicateContactCandidates } from "../src/contact-export/contact-deduplicator";
import type { RawContactCandidate } from "../src/contact-export/types";

function candidate(overrides: Partial<RawContactCandidate> = {}): RawContactCandidate {
  return {
    sourceId: "row-1",
    labelName: "Microcentro",
    name: "Juan Pérez",
    phoneCandidate: "5491123456789@c.us",
    phoneSource: "jid",
    kind: "contact",
    strategy: "test-jid",
    ...overrides
  };
}

describe("contact export deduplication", () => {
  it("merges the same phone found in multiple selected labels", () => {
    const result = deduplicateContactCandidates([
      candidate(),
      candidate({ sourceId: "row-2", labelName: "Premium" })
    ]);
    expect(result.contacts).toEqual([expect.objectContaining({
      phone: "+5491123456789",
      name: "Juan Pérez",
      zone: "Microcentro | Premium",
      labels: ["Microcentro", "Premium"]
    })]);
    expect(result.summary.duplicatesRemoved).toBe(1);
  });

  it("fills a missing name if another occurrence of the same phone has one", () => {
    const result = deduplicateContactCandidates([
      candidate({ name: "" }),
      candidate({ sourceId: "row-2", labelName: "Tribunales", name: "María Gómez" })
    ]);
    expect(result.contacts[0]?.name).toBe("María Gómez");
    expect(result.summary.withoutName).toBe(0);
  });

  it("keeps a valid phone even when the name is missing", () => {
    const result = deduplicateContactCandidates([candidate({ name: "" })]);
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]?.name).toBe("");
    expect(result.summary.withoutName).toBe(1);
  });

  it("reports a contact without a reliable phone instead of inventing one", () => {
    const result = deduplicateContactCandidates([
      candidate({ phoneCandidate: null, phoneSource: "none" })
    ]);
    expect(result.contacts).toHaveLength(0);
    expect(result.summary.withoutPhone).toBe(1);
    expect(result.problems[0]?.reason).toBe("PHONE_NOT_AVAILABLE");
  });

  it("excludes groups and preserves a foreign personal number", () => {
    const result = deduplicateContactCandidates([
      candidate({ sourceId: "group", kind: "group", phoneCandidate: null, phoneSource: "none" }),
      candidate({ sourceId: "foreign", name: "Ana", phoneCandidate: "+34612345678", phoneSource: "visible_international" })
    ]);
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]?.phone).toBe("+34612345678");
    expect(result.summary.excludedNonContacts).toBe(1);
  });
});
