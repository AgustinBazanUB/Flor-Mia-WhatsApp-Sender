import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createInboxInternalEnvelope,
  INBOX_INTERNAL_CHANNEL,
  INBOX_INTERNAL_TYPES,
  isInboxInternalEnvelope
} from "../src/shared/inbox-protocol";

const root = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

describe("WhatsApp Inbox isolated protocol", () => {
  it("accepts only the bounded chat-list command", () => {
    const message = createInboxInternalEnvelope("web-app-inbox-bridge", INBOX_INTERNAL_TYPES.getChats, { limit: 80 }, "request-chats");
    expect(message.channel).toBe(INBOX_INTERNAL_CHANNEL);
    expect(isInboxInternalEnvelope(message)).toBe(true);
    expect(isInboxInternalEnvelope({ ...message, payload: { limit: 101 } })).toBe(false);
  });

  it("rejects arbitrary commands and oversized SEND_TEXT payloads", () => {
    const base = createInboxInternalEnvelope("web-app-inbox-bridge", INBOX_INTERNAL_TYPES.sendText, {
      chatId: "wa-chat-123",
      message: "Hola"
    }, "request-send");
    expect(isInboxInternalEnvelope(base)).toBe(true);
    expect(isInboxInternalEnvelope({ ...base, type: "EXECUTE_ARBITRARY_CODE" })).toBe(false);
    expect(isInboxInternalEnvelope({ ...base, payload: { chatId: "wa-chat-123", message: "x".repeat(4097) } })).toBe(false);
  });

  it("rejects unknown sources and malformed chat identifiers", () => {
    const message = createInboxInternalEnvelope("web-app-inbox-bridge", INBOX_INTERNAL_TYPES.getMessages, {
      chatId: "wa-chat-123",
      limit: 50
    }, "request-messages");
    expect(isInboxInternalEnvelope({ ...message, source: "external-site" })).toBe(false);
    expect(isInboxInternalEnvelope({ ...message, payload: { chatId: "", limit: 50 } })).toBe(false);
  });
});

describe("WhatsApp Inbox packaging contract", () => {
  it("uses a dedicated external channel with a reinjection guard", async () => {
    const bridge = await source("src/content/inbox-web-app-bridge.ts");
    expect(bridge).toContain('flor_mia_whatsapp_inbox_extension');
    expect(bridge).toContain("__florMiaWhatsAppInboxBridgeV1");
    expect(bridge).toContain("isAllowedWebAppOrigin");
  });

  it("guards the WhatsApp-side listener so reinjection cannot duplicate SEND_TEXT", async () => {
    const runtime = await source("src/content/inbox-runtime.ts");
    expect(runtime).toContain("__florMiaWhatsAppInboxRuntimeV1");
    expect(runtime).toContain("removeListener");
  });

  it("keeps contact-export and campaign scripts while adding Inbox scripts", async () => {
    const manifest = JSON.parse(await source("manifest.json")) as {
      version: string;
      content_scripts: Array<{ js: string[] }>;
    };
    const scripts = manifest.content_scripts.flatMap((entry) => entry.js);
    expect(manifest.version).toBe("0.9.6.1");
    expect(scripts).toContain("content/whatsapp.js");
    expect(scripts).toContain("content/inbox-runtime.js");
    expect(scripts).toContain("content/web-app-bridge.js");
    expect(scripts).toContain("content/inbox-web-app-bridge.js");
    const recovery = await source("src/background/recovery-bootstrap.ts");
    expect(recovery).toContain('import "./contact-export-bootstrap"');
    expect(recovery).toContain('import "./message-contact-bootstrap"');
    expect(recovery).toContain('import "./inbox-service-worker"');
  });
});
