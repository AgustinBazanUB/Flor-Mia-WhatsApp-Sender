// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createInboxInternalEnvelope,
  INBOX_INTERNAL_CHANNEL,
  INBOX_INTERNAL_TYPES,
  isInboxInternalEnvelope
} from "../src/shared/inbox-protocol";
import { getInboxChats } from "../src/whatsapp/inbox-adapter";

async function source(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("WhatsApp Inbox isolated protocol", () => {
  it("accepts only bounded commands", () => {
    const message = createInboxInternalEnvelope("web-app-inbox-bridge", INBOX_INTERNAL_TYPES.getChats, { limit: 80 }, "request-chats");
    expect(message.channel).toBe(INBOX_INTERNAL_CHANNEL);
    expect(isInboxInternalEnvelope(message)).toBe(true);
    expect(isInboxInternalEnvelope({ ...message, payload: { limit: 101 } })).toBe(false);
  });

  it("rejects arbitrary commands, empty messages and oversized SEND_TEXT payloads", () => {
    const base = createInboxInternalEnvelope("web-app-inbox-bridge", INBOX_INTERNAL_TYPES.sendText, { chatId: "wa-chat-123", message: "Hola" }, "request-send");
    expect(isInboxInternalEnvelope(base)).toBe(true);
    expect(isInboxInternalEnvelope({ ...base, type: "EXECUTE_ARBITRARY_CODE" })).toBe(false);
    expect(isInboxInternalEnvelope({ ...base, payload: { chatId: "wa-chat-123", message: "   " } })).toBe(false);
    expect(isInboxInternalEnvelope({ ...base, payload: { chatId: "wa-chat-123", message: "x".repeat(4097) } })).toBe(false);
  });

  it("rejects unknown sources and malformed identifiers", () => {
    const message = createInboxInternalEnvelope("web-app-inbox-bridge", INBOX_INTERNAL_TYPES.getMessages, { chatId: "wa-chat-123", limit: 50 }, "request-messages");
    expect(isInboxInternalEnvelope({ ...message, source: "external-site" })).toBe(false);
    expect(isInboxInternalEnvelope({ ...message, payload: { chatId: "", limit: 50 } })).toBe(false);
    expect(isInboxInternalEnvelope({ ...message, requestId: "" })).toBe(false);
  });
});

describe("WhatsApp Inbox chat identity", () => {
  it("keeps chat identity stable when rows reorder and last messages change", () => {
    document.body.innerHTML = `<div id="pane-side">
      <div role="row" data-jid="5491112345678@c.us"><span title="María">María</span><span>Hola</span></div>
      <div role="row" data-jid="5491198765432@c.us"><span title="Juan">Juan</span><span>Buen día</span></div>
    </div>`;
    const first = getInboxChats();
    const pane = document.getElementById("pane-side");
    expect(pane).not.toBeNull();
    const rows = pane ? [...pane.children] : [];
    if (pane && rows[1] && rows[0]) {
      pane.insertBefore(rows[1], rows[0]);
      rows[0].querySelector("span:last-child")?.replaceChildren("Mensaje nuevo");
    }
    const second = getInboxChats();
    const firstIds = new Map(first.map((chat) => [chat.name, chat.chatId]));
    expect(second.find((chat) => chat.name === "María")?.chatId).toBe(firstIds.get("María"));
    expect(second.find((chat) => chat.name === "Juan")?.chatId).toBe(firstIds.get("Juan"));
  });

  it("preserves the literal 99+ unread representation without inventing an exact count", () => {
    document.body.innerHTML = `<div id="pane-side"><div role="row" data-jid="5491112345678@c.us">
      <span title="María">María</span><span data-testid="unread-count" aria-label="99+ mensajes no leídos">99+</span>
    </div></div>`;
    const [chat] = getInboxChats();
    expect(chat?.unreadCount).toBe(99);
    expect(chat?.unreadDisplay).toBe("99+");
  });

  it("classifies groups separately and never exposes them as CRM phones", () => {
    document.body.innerHTML = `<div id="pane-side"><div role="row" data-jid="120363000000@g.us"><span title="Equipo">Equipo</span></div></div>`;
    const [chat] = getInboxChats();
    expect(chat?.chatType).toBe("group");
    expect(chat?.phone).toBeNull();
  });
});

describe("WhatsApp Inbox packaging and hardening contract", () => {
  it("uses a dedicated external channel with a reinjection guard", async () => {
    const bridge = await source("src/content/inbox-web-app-bridge.ts");
    expect(bridge).toContain('flor_mia_whatsapp_inbox_extension');
    expect(bridge).toContain("__florMiaWhatsAppInboxBridgeV1");
    expect(bridge).toContain("isAllowedWebAppOrigin");
  });

  it("guards WhatsApp-side listeners so reinjection cannot duplicate SEND_TEXT", async () => {
    const runtime = await source("src/content/inbox-runtime.ts");
    expect(runtime).toContain("__florMiaWhatsAppInboxRuntimeV1");
    expect(runtime).toContain("removeListener");
  });

  it("persists SEND_TEXT idempotency and coordinates campaign/contact-export conflicts", async () => {
    const worker = await source("src/background/inbox-service-worker.ts");
    expect(worker).toContain("whatsappInboxSendCacheV1");
    expect(worker).toContain("inFlightSends");
    expect(worker).toContain("ContactExportStore");
    expect(worker).toContain("OPERATION_CONFLICT");
    expect(worker).toContain("requestId");
  });

  it("protects drafts and never reports an unverified send as sent", async () => {
    const adapter = await source("src/whatsapp/inbox-adapter.ts");
    expect(adapter).toContain("COMPOSER_HAS_DRAFT");
    expect(adapter).toContain("SEND_STATUS_UNKNOWN");
    expect(adapter).toContain("ambiguousResult");
  });

  it("keeps Contact Export and campaign scripts while releasing Inbox hardening as 0.9.7", async () => {
    const manifest = JSON.parse(await source("manifest.json")) as { version: string; content_scripts: Array<{ js: string[] }> };
    const scripts = manifest.content_scripts.flatMap((entry) => entry.js);
    expect(manifest.version).toBe("0.9.7");
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
