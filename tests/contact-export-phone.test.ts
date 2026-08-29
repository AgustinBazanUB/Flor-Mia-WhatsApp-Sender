import { describe, expect, it } from "vitest";
import {
  canonicalExportPhoneKey,
  normalizeExportPhoneCandidate,
  normalizeStructuredPhone,
  normalizeVisibleInternationalPhone,
  normalizeWhatsAppJidPhone
} from "../src/contact-export/phone-normalizer";

describe("contact export phone normalization", () => {
  it("preserves an explicit Argentine international mobile number", () => {
    expect(normalizeVisibleInternationalPhone("+54 9 11 2345-6789")).toEqual({ e164: "+5491123456789", digits: "5491123456789" });
  });

  it("normalizes an explicit 00 international prefix without guessing the country", () => {
    expect(normalizeVisibleInternationalPhone("0034 612 345 678")).toEqual({ e164: "+34612345678", digits: "34612345678" });
  });

  it("rejects local ambiguous numbers because country information is missing", () => {
    expect(normalizeVisibleInternationalPhone("11 2345-6789")).toBeNull();
    expect(normalizeVisibleInternationalPhone("5757-1979")).toBeNull();
  });

  it("accepts personal WhatsApp JIDs and rejects group JIDs", () => {
    expect(normalizeWhatsAppJidPhone("5491123456789@c.us")?.e164).toBe("+5491123456789");
    expect(normalizeWhatsAppJidPhone("34612345678@s.whatsapp.net")?.e164).toBe("+34612345678");
    expect(normalizeWhatsAppJidPhone("120363001234567890@g.us")).toBeNull();
  });

  it("accepts digits only from a field whose semantics explicitly declare phone", () => {
    expect(normalizeStructuredPhone("5491123456789")?.e164).toBe("+5491123456789");
    expect(normalizeStructuredPhone("34612345678")?.e164).toBe("+34612345678");
    expect(normalizeStructuredPhone("123")).toBeNull();
  });

  it("resolves according to the source without converting a local visible number", () => {
    expect(normalizeExportPhoneCandidate("5491123456789@c.us", "jid")?.e164).toBe("+5491123456789");
    expect(normalizeExportPhoneCandidate("34612345678", "structured_phone")?.e164).toBe("+34612345678");
    expect(normalizeExportPhoneCandidate("11 2345-6789", "visible_international")).toBeNull();
  });

  it("uses normalized international digits as the dedupe key", () => {
    expect(canonicalExportPhoneKey("+34 612 345 678")).toBe("34612345678");
    expect(canonicalExportPhoneKey("11 2345-6789")).toBe("");
  });
});
