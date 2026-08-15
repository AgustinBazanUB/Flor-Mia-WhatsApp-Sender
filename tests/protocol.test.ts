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

describe("typed protocol", () => {
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
    expect(isWebAppInboundEnvelope({ ...ping, type: WEB_APP_MESSAGE_TYPES.completed })).toBe(false);
    expect(isWebAppInboundEnvelope({ ...ping, requestId: undefined })).toBe(false);
  });
});
