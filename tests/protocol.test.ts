import { describe, expect, it } from "vitest";
import {
  createInternalRequest,
  INTERNAL_MESSAGE_TYPES,
  isInternalEnvelope,
  isWebAppInboundEnvelope,
  PROTOCOL_VERSION,
  WEB_APP_CHANNEL,
  WEB_APP_MESSAGE_TYPES
} from "../src/shared/protocol";
import { isAllowedWebAppOrigin } from "../src/config/origins";

describe("typed protocol", () => {
  it("accepts only the explicit Flor Mía and local development origins", () => {
    expect(isAllowedWebAppOrigin("https://app-integral-fm.netlify.app")).toBe(true);
    expect(isAllowedWebAppOrigin("https://deploy-preview-7--app-integral-fm.netlify.app")).toBe(true);
    expect(isAllowedWebAppOrigin("https://deploy-preview-7--appintegralflormia.netlify.app")).toBe(true);
    expect(isAllowedWebAppOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedWebAppOrigin("https://app-integral-fm.netlify.app.evil.example")).toBe(false);
    expect(isAllowedWebAppOrigin("https://deploy-preview-8--appintegralflormia.netlify.app")).toBe(false);
    expect(isAllowedWebAppOrigin("https://example.com")).toBe(false);
  });
  it("creates and validates internal envelopes", () => {
    const message = createInternalRequest("popup", INTERNAL_MESSAGE_TYPES.sendTestText, { phone: "+5491112345678", message: "Hola" }, "req-1");
    expect(isInternalEnvelope(message)).toBe(true);
    expect(message.requestId).toBe("req-1");
  });

  it("rejects arbitrary and version-mismatched internal messages", () => {
    expect(isInternalEnvelope({ type: "send this" })).toBe(false);
    const message = createInternalRequest("popup", INTERNAL_MESSAGE_TYPES.getState, {});
    expect(isInternalEnvelope({ ...message, protocolVersion: 999 })).toBe(false);
  });

  it("accepts only Web-App request types with a request id", () => {
    const ping = {
      channel: WEB_APP_CHANNEL,
      protocolVersion: PROTOCOL_VERSION,
      type: WEB_APP_MESSAGE_TYPES.ping,
      requestId: "web-1",
      payload: {}
    };
    expect(isWebAppInboundEnvelope(ping)).toBe(true);
    expect(isWebAppInboundEnvelope({ ...ping, type: WEB_APP_MESSAGE_TYPES.preflightRequest })).toBe(true);
    expect(isWebAppInboundEnvelope({ ...ping, type: WEB_APP_MESSAGE_TYPES.completed })).toBe(false);
    expect(isWebAppInboundEnvelope({ ...ping, requestId: undefined })).toBe(false);
  });

  it("accepts campaign controls but never outbound progress as inbound commands", () => {
    const base = {
      channel: WEB_APP_CHANNEL,
      protocolVersion: PROTOCOL_VERSION,
      requestId: "web-control-1",
      campaignId: "campaign-1",
      payload: {}
    };
    for (const type of [
      WEB_APP_MESSAGE_TYPES.startRequest,
      WEB_APP_MESSAGE_TYPES.pauseRequest,
      WEB_APP_MESSAGE_TYPES.resumeRequest,
      WEB_APP_MESSAGE_TYPES.stopRequest,
      WEB_APP_MESSAGE_TYPES.statusRequest
    ]) {
      expect(isWebAppInboundEnvelope({ ...base, type })).toBe(true);
    }
    expect(isWebAppInboundEnvelope({ ...base, type: WEB_APP_MESSAGE_TYPES.progress })).toBe(false);
  });

  it("validates a complete serialized campaign payload at the production boundary", () => {
    const prepare = {
      channel: WEB_APP_CHANNEL,
      protocolVersion: PROTOCOL_VERSION,
      type: WEB_APP_MESSAGE_TYPES.prepare,
      requestId: "prepare-1",
      campaignId: "campaign-1",
      payload: {
        campaignId: "campaign-1",
        campaignName: "Campaña",
        createdBy: "flor_mia",
        recipients: [{ recipientId: "recipient-1", phone: "5491112345678", name: "Cliente", source: "flor_mia" }],
        message: "Hola",
        images: [],
        imageOrder: [],
        imageCount: 0,
        totalRecipients: 1
      }
    };
    expect(isWebAppInboundEnvelope(prepare)).toBe(true);
    expect(isWebAppInboundEnvelope({ ...prepare, payload: { ...prepare.payload, totalRecipients: "1" } })).toBe(false);
    expect(isWebAppInboundEnvelope({ ...prepare, payload: { campaignId: "campaign-1" } })).toBe(false);
  });

  it("rejects development fault controls recursively from the production Web-App", () => {
    const base = {
      channel: WEB_APP_CHANNEL,
      protocolVersion: PROTOCOL_VERSION,
      type: WEB_APP_MESSAGE_TYPES.startRequest,
      requestId: "start-1",
      campaignId: "campaign-1"
    };
    expect(isWebAppInboundEnvelope({ ...base, payload: { developmentFault: "selector_break" } })).toBe(false);
    expect(isWebAppInboundEnvelope({ ...base, payload: { nested: { faultInjection: { step: "text" } } } })).toBe(false);
    const tooDeep = Array.from({ length: 10 }).reduce<Record<string, unknown>>((child, _, index) => ({ [`level${index}`]: child }), {});
    expect(isWebAppInboundEnvelope({ ...base, payload: tooDeep })).toBe(false);
    expect(isWebAppInboundEnvelope({ ...base, payload: {} })).toBe(true);
  });

  it("keeps compatibility fault injection outside the Web-App protocol", () => {
    const internal = createInternalRequest(
      "popup",
      INTERNAL_MESSAGE_TYPES.setCompatibilityDevelopmentFault,
      { fault: "next_health_check_break" },
      "compatibility-dev-1"
    );
    expect(isInternalEnvelope(internal)).toBe(true);
    expect(Object.values(WEB_APP_MESSAGE_TYPES)).not.toContain(INTERNAL_MESSAGE_TYPES.setCompatibilityDevelopmentFault);
  });

  it("accepts diagnostic report requests only as typed internal messages", () => {
    const request = createInternalRequest(
      "diagnostics-page",
      INTERNAL_MESSAGE_TYPES.generateDiagnosticReport,
      { includeCampaignName: false },
      "diagnostic-report-1"
    );
    expect(isInternalEnvelope(request)).toBe(true);
    expect(Object.values(WEB_APP_MESSAGE_TYPES)).not.toContain(INTERNAL_MESSAGE_TYPES.generateDiagnosticReport);
  });
});
