import { describe, expect, it } from "vitest";
import { normalizePhone, maskPhone } from "../src/shared/phone";

describe("phone normalization", () => {
  it("normalizes an explicit international number", () => {
    expect(normalizePhone("+54 9 11 1234-5678")).toEqual({
      e164: "+5491112345678",
      digits: "5491112345678",
      masked: "+54*******5678"
    });
  });

  it("never assumes a country", () => {
    expect(() => normalizePhone("11 1234-5678")).toThrow(/formato internacional/i);
  });

  it("rejects impossible international lengths", () => {
    expect(() => normalizePhone("+123")).toThrow(/entre 8 y 15/i);
  });

  it("masks phone-like identifiers", () => {
    expect(maskPhone("+59899123456")).toBe("+59*****3456");
  });
});
