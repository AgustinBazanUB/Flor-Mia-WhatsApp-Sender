import { describe, expect, it } from "vitest";
import { redactLogValue } from "../src/shared/logger";

describe("logger redaction", () => {
  it("redacts private text and masks phone numbers", () => {
    expect(redactLogValue({ phone: "+5491112345678", message: "contenido privado", count: 1 })).toEqual({
      phone: "+54*******5678",
      message: "[REDACTED]",
      count: 1
    });
  });
});
