import { describe, expect, it } from "vitest";
import { DEFAULT_CAMPAIGN_POLICY } from "../src/campaign/campaign-policy";
import { createCampaignState } from "../src/campaign/campaign-store";
import { refreshDailyLimit } from "../src/campaign/daily-limit";
import { sanitizeCampaignForReport, sanitizeCandidate, sanitizeDiagnosticValue, sanitizeError, sanitizeStackTrace } from "../src/diagnostics/sanitizer";
import { ERROR_CODES, type SerializedExtensionError } from "../src/shared/errors";
import { validateCampaignInput } from "../src/shared/campaign";

const FULL_PHONE = "+54 9 11 2345-6789";
const SECRET_MESSAGE = `Oferta privada para ${FULL_PHONE}: dos ramos especiales`;
const BASE64 = "A".repeat(160);

function campaign() {
  const validated = validateCampaignInput({
    campaignId: "privacy-campaign",
    campaignName: "Campaña privada",
    createdBy: "admin",
    recipients: [{ recipientId: "recipient-safe", phone: "5491123456789", source: "flor_mia" }],
    message: SECRET_MESSAGE,
    imageCount: 1,
    imageOrder: [1],
    images: [{ order: 1, name: "private.png", type: "image/png", size: 1, data: new Uint8Array([1]).buffer }],
    totalRecipients: 1
  });
  return createCampaignState(
    validated,
    DEFAULT_CAMPAIGN_POLICY,
    refreshDailyLimit(null, 1_000, new Date(2026, 7, 15, 10)),
    "2026-08-15T13:00:00.000Z"
  );
}

describe("diagnostic privacy sanitizers", () => {
  it("never exports the recipient list, full campaign message, or counted contact keys", () => {
    const source = campaign();
    const report = sanitizeCampaignForReport(source);
    const serialized = JSON.stringify(report);

    expect(report).not.toHaveProperty("recipients");
    expect(report?.campaignName).toBeNull();
    expect(report?.messageMetadata).toEqual({ length: SECRET_MESSAGE.length, localFingerprint: null });
    expect(report?.dailyLimit).not.toHaveProperty("countedContactKeys");
    expect(serialized).not.toContain(FULL_PHONE);
    expect(serialized).not.toContain(SECRET_MESSAGE);
  });

  it("redacts adversarial error details, camelCase secrets, phones, messages and base64", () => {
    const error: SerializedExtensionError = {
      code: ERROR_CODES.whatsappUiChanged,
      message: `Falló ${SECRET_MESSAGE}`,
      recoverable: true,
      details: {
        phone: FULL_PHONE,
        accessToken: "token-ultra-secreto",
        cookieValue: "cookie-ultra-secreta",
        dataBase64: BASE64,
        nested: { message: SECRET_MESSAGE, context: `contact=${FULL_PHONE}` }
      },
      stack: `Error: fallo\n at send (https://web.whatsapp.com/send?phone=5491123456789&token=secret)\n at C:\\Users\\agustin\\project\\file.ts:10:2`
    };
    const sanitized = sanitizeError(error, { sensitiveStrings: [SECRET_MESSAGE] });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(FULL_PHONE);
    expect(serialized).not.toContain(SECRET_MESSAGE);
    expect(serialized).not.toContain("token-ultra-secreto");
    expect(serialized).not.toContain("cookie-ultra-secreta");
    expect(serialized).not.toContain(BASE64);
    expect(sanitized?.stack).toContain("https://web.whatsapp.com/send");
    expect(sanitized?.stack).not.toContain("phone=");
    expect(sanitized?.stack).toContain("<local>\\project");
  });

  it("keeps only structural candidate summaries and removes accidental names or DOM text", () => {
    const sanitized = sanitizeCandidate({
      tagName: "button",
      role: "button",
      ariaLabel: "Enviar a Juan Pérez",
      dataTestId: "compose-btn-send",
      hierarchyHint: "div Juan Pérez > button[role=button]",
      innerText: SECRET_MESSAGE,
      outerHTML: `<button>${SECRET_MESSAGE}</button>`
    });
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.ariaLabel).toBe("[REDACTED]");
    expect(sanitized.hierarchyHint).toBe("[REDACTED]");
    expect(sanitized.dataTestId).toBe("compose-btn-send");
    expect(serialized).not.toContain("Juan Pérez");
    expect(serialized).not.toContain(SECRET_MESSAGE);
    expect(sanitized).not.toHaveProperty("innerText");
    expect(sanitized).not.toHaveProperty("outerHTML");
  });

  it("sanitizes standalone stacks and generic sensitive keys", () => {
    expect(sanitizeStackTrace(`at x (https://web.whatsapp.com/?phone=5491123456789)`)).toBe("at x (https://web.whatsapp.com/)");
    expect(sanitizeDiagnosticValue({ qrPayload: BASE64, credentialSecret: "secret", safe: FULL_PHONE })).toEqual({
      qrPayload: "[REDACTED]",
      credentialSecret: "[REDACTED]",
      safe: "[REDACTED_PHONE]"
    });
  });
});
