import { describe, expect, it } from "vitest";
import { deduplicateContactCandidates } from "../src/contact-export/contact-deduplicator";
import type { RawContactCandidate } from "../src/contact-export/types";

function candidate(overrides: Partial<RawContactCandidate> = {}): RawContactCandidate {
  return {
    sourceId: "row-1",
    contactId: "5491123456789@c.us",
    labelId: "label-microcentro",
    labelName: "Microcentro",
    name: "Juan Pérez",
    phoneCandidate: "5491123456789@c.us",
    phoneSource: "jid",
    phoneStatus: "resolved",
    kind: "contact",
    strategy: "test-jid",
    ...overrides
  };
}

describe("contact export phone-first deduplication", () => {
  it("merges the same phone found in multiple selected labels", () => {
    const result = deduplicateContactCandidates([
      candidate(),
      candidate({ sourceId: "row-2", labelId: "label-premium", labelName: "Premium" })
    ]);
    expect(result.contacts).toEqual([expect.objectContaining({
      phone: "+5491123456789",
      name: "Juan Pérez",
      zone: "Microcentro | Premium",
      labels: ["Microcentro", "Premium"]
    })]);
    expect(result.summary.duplicatesRemoved).toBe(1);
  });

  it("keeps ten unique contacts even when two rows are rendered again", () => {
    const base = Array.from({ length: 10 }, (_, index) => candidate({
      sourceId: `row-${index}`,
      contactId: `54911000000${index}@c.us`,
      phoneCandidate: `54911000000${index}@c.us`,
      name: `Cliente ${index}`
    }));
    const result = deduplicateContactCandidates([...base, base[2]!, base[7]!]);
    expect(result.contacts).toHaveLength(10);
    expect(result.summary.duplicatesRemoved).toBe(2);
  });

  it("does not deduplicate two people only because they share the same name", () => {
    const result = deduplicateContactCandidates([
      candidate({ sourceId: "a", contactId: "5491123456789@c.us", phoneCandidate: "5491123456789@c.us", name: "Juan Pérez" }),
      candidate({ sourceId: "b", contactId: "5491198765432@c.us", phoneCandidate: "5491198765432@c.us", name: "Juan Pérez" })
    ]);
    expect(result.contacts).toHaveLength(2);
    expect(result.summary.duplicatesRemoved).toBe(0);
  });

  it("keeps the selected label name literally as Zona", () => {
    const result = deduplicateContactCandidates([candidate({ labelId: "faltas", labelName: "Falta enviar" })]);
    expect(result.contacts[0]?.zone).toBe("Falta enviar");
  });

  it("fills a missing name if another occurrence of the same phone has one", () => {
    const result = deduplicateContactCandidates([
      candidate({ name: "" }),
      candidate({ sourceId: "row-2", labelId: "tribunales", labelName: "Tribunales", name: "María Gómez" })
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

  it("reports PHONE_UNRESOLVED instead of inventing a number", () => {
    const result = deduplicateContactCandidates([
      candidate({ contactId: "opaque@lid", phoneCandidate: null, phoneSource: "none", phoneStatus: "unresolved" })
    ]);
    expect(result.contacts).toHaveLength(0);
    expect(result.summary.withoutPhone).toBe(1);
    expect(result.problems[0]?.reason).toBe("PHONE_UNRESOLVED");
  });

  it("reports an explicitly malformed structured phone as PHONE_INVALID", () => {
    const result = deduplicateContactCandidates([
      candidate({ phoneCandidate: "123", phoneSource: "structured_phone", phoneStatus: "invalid" })
    ]);
    expect(result.contacts).toHaveLength(0);
    expect(result.problems[0]?.reason).toBe("PHONE_INVALID");
  });

  it("excludes groups and preserves a foreign personal number", () => {
    const result = deduplicateContactCandidates([
      candidate({ sourceId: "group", contactId: "120363@g.us", kind: "group", phoneCandidate: null, phoneSource: "none", phoneStatus: "unresolved" }),
      candidate({ sourceId: "foreign", contactId: null, name: "Ana", phoneCandidate: "+34612345678", phoneSource: "visible_international", phoneStatus: "resolved" })
    ]);
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]?.phone).toBe("+34612345678");
    expect(result.summary.excludedNonContacts).toBe(1);
  });
});
