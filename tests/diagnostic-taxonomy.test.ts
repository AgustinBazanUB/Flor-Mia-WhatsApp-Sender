import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../src/shared/errors";
import { classifyDiagnosticError } from "../src/diagnostics/taxonomy";

describe("diagnostic error taxonomy", () => {
  it.each([
    [ERROR_CODES.storageError, "EXTENSION_ERROR"],
    [ERROR_CODES.interfaceLoading, "TEMPORARY_WHATSAPP_ERROR"],
    [ERROR_CODES.invalidContact, "CONTACT_ERROR"],
    [ERROR_CODES.sessionNotReady, "AUTH_ERROR"],
    [ERROR_CODES.selectorStrategyExhausted, "WHATSAPP_UI_CHANGED"],
    [ERROR_CODES.ambiguousResult, "AMBIGUOUS_SEND_RESULT"],
    [ERROR_CODES.imageMissing, "RESOURCE_ERROR"],
    [ERROR_CODES.dailyLimitReached, "DAILY_LIMIT"],
    [ERROR_CODES.campaignStopped, "USER_STOP"]
  ] as const)("maps %s to %s", (code, expected) => {
    expect(classifyDiagnosticError({ code })).toBe(expected);
  });

  it("distinguishes an offline timeout from a temporary WhatsApp timeout", () => {
    expect(classifyDiagnosticError({ code: ERROR_CODES.timeout }, { online: false })).toBe("CONNECTION_ERROR");
    expect(classifyDiagnosticError({ code: ERROR_CODES.timeout }, { online: true })).toBe("TEMPORARY_WHATSAPP_ERROR");
  });

  it("classifies campaign blocks and user actions without replacing existing error codes", () => {
    expect(classifyDiagnosticError(null, { campaignBlockCode: "manual_pause" })).toBe("USER_PAUSE");
    expect(classifyDiagnosticError(null, { campaignBlockCode: "stopped" })).toBe("USER_STOP");
    expect(classifyDiagnosticError(null, { campaignBlockCode: "daily_limit_reached" })).toBe("DAILY_LIMIT");
    expect(classifyDiagnosticError(null, { campaignBlockCode: "whatsapp_session_closed" })).toBe("AUTH_ERROR");
    expect(classifyDiagnosticError(null, { campaignBlockCode: "whatsapp_tab_closed" })).toBe("CONNECTION_ERROR");
    expect(classifyDiagnosticError(null, { campaignBlockCode: "whatsapp_reloading" })).toBe("TEMPORARY_WHATSAPP_ERROR");
  });
});
