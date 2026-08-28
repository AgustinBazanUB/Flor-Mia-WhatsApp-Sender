import { describe, expect, it } from "vitest";
import {
  canonicalExportPhoneKey,
  normalizeVisibleInternationalPhone,
  normalizeWhatsAppJidPhone
} from "../src/contact-export/phone-normalizer";

describe("contact export phone normalization", () => {
  it("preserves an explicit Argentine international mobile number", () => {
    expect(normalizeVisibleInternationalPhone("+54 9 11 2345-6789")).toEqual({
      e164: "+5491123456789",
      digits: "5491123456789"
    });
  });

  it("normalizes an explicit 00 international prefix without guessing the country", () => {
    expect(normalizeVisibleInternationalPhone("0034 612 345 678")).toEqual({
      e164: "+34612345678",
      digits: "34612345678"
    });
  });

  it("rejects a local number because country information is missing", () => {
    expect(normalizeVisibleInternationalPhone("11 2345-6789")).toBeNull();
  });

  it("accepts personal WhatsApp JIDs and rejects group JIDs", () => {
    expect(normalizeWhatsAppJidPhone("5491123456789@c.us")).toEqual({
      e164: "+5491123456789",
      digits: "5491123456789"
    });
    expect(normalizeWhatsAppJidPhone("120363001234567890@g.us")).toBeNull();
  });

  it("uses the normalized international digits as the dedupe key", () => {
    expect(canonicalExportPhoneKey("+34 612 345 678")).toBe("34612345678");
  });
});
