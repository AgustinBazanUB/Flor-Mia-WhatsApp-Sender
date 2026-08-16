import { describe, expect, it } from "vitest";
import { ChromeWhatsAppContactAdapter } from "../src/background/contact-adapter";
import type { WhatsAppTransport } from "../src/background/whatsapp-transport";
import { createUnavailablePreflight } from "../src/compatibility/preflight-result";
import { createContactCheckpoint } from "../src/engine/steps";
import type { InternalMessageType } from "../src/shared/protocol";
import { ERROR_CODES, ExtensionError } from "../src/shared/errors";

const NOW = "2026-08-16T12:00:00.000Z";

function green() {
  return {
    ...createUnavailablePreflight("GREEN", {}, { pageDetected: true, contentScriptConnected: true }),
    documentReady: true,
    sessionReady: true,
    mainInterfaceReady: true,
    operational: true,
    overallStatus: "GREEN" as const,
    status: "ready" as const
  };
}

function checkpoint() {
  return createContactCheckpoint({
    campaignId: "campaign-1",
    campaignName: "Binding",
    contact: { contactId: "recipient-1", phoneDigits: "5491112345678", maskedPhone: "+54••••••78" },
    images: [{ imageId: "image-1", order: 1, name: "image.png", type: "image/png", size: 3 }],
    text: "Hola",
    now: NOW
  });
}

describe("active WhatsApp tab binding", () => {
  it("uses the same tab for open, proof, image, text and reconciliation even if discovery order changes", async () => {
    const calls: Array<{ type: InternalMessageType; tabId?: number }> = [];
    let discoveryCalls = 0;
    const fakeTransport = {
      requireTab: async () => { discoveryCalls += 1; return { id: 11, url: "https://web.whatsapp.com/" }; },
      requireTabId: async (id: number) => ({ id, url: "https://web.whatsapp.com/" }),
      waitForContent: async () => green(),
      send: async (type: InternalMessageType, _payload: unknown, tabId?: number) => {
        calls.push({ type, tabId });
        if (type === "WA_OPEN_CONVERSATION") return { navigationStarted: true };
        if (type === "WA_PROVE_CONVERSATION") return { verified: true, evidence: "structured-recipient-id", checkedAt: NOW };
        if (type === "WA_SEND_IMAGE") return { success: true, verification: { outcome: "confirmed", method: "fake", observedAt: NOW, sendAttempted: true } };
        if (type === "WA_SEND_TEXT") return { success: true, completedAt: NOW, verification: { confirmed: true, method: "new-outgoing-message-dom" } };
        return { outcome: "confirmed", verification: { outcome: "confirmed", method: "fake", observedAt: NOW, sendAttempted: true } };
      }
    };
    const adapter = new ChromeWhatsAppContactAdapter({
      getImage: async () => ({ blob: new Blob([new Uint8Array([1, 2, 3])]) }) as never
    }, fakeTransport as unknown as WhatsAppTransport);
    const state = checkpoint();
    const context = { checkpoint: state, timeoutMs: 10, imageLoadTimeoutMs: 10, previewTimeoutMs: 10 };

    await adapter.openConversation(state.contact, 10);
    await adapter.sendImage(state.steps[0] as never, context);
    await adapter.sendText(state.steps[1] as never, context);
    await adapter.reconcile(state.steps[1]!, context);

    expect(discoveryCalls).toBe(1);
    expect(calls.map((call) => call.tabId)).toEqual([11, 11, 11, 11, 11]);
  });

  it("does not fall back to another tab when the bound tab closes", async () => {
    let boundOpen = true;
    let discoveryCalls = 0;
    const fakeTransport = {
      requireTab: async () => { discoveryCalls += 1; return { id: 11, url: "https://web.whatsapp.com/" }; },
      requireTabId: async () => {
        if (!boundOpen) throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "closed");
        return { id: 11, url: "https://web.whatsapp.com/" };
      },
      waitForContent: async () => green(),
      send: async (type: InternalMessageType) => {
        if (!boundOpen) throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "closed");
        if (type === "WA_OPEN_CONVERSATION") return { navigationStarted: true };
        return { verified: true, evidence: "structured-recipient-id", checkedAt: NOW };
      }
    };
    const adapter = new ChromeWhatsAppContactAdapter({ getImage: async () => null }, fakeTransport as unknown as WhatsAppTransport);
    const state = checkpoint();
    await adapter.openConversation(state.contact, 10);
    boundOpen = false;
    const result = await adapter.sendText(state.steps[1] as never, {
      checkpoint: state, timeoutMs: 10, imageLoadTimeoutMs: 10, previewTimeoutMs: 10
    });
    expect(result).toMatchObject({ outcome: "failed", error: { code: "WHATSAPP_NOT_OPEN" } });
    expect(discoveryCalls).toBe(1);
  });

  it("keeps the same binding when the Content Script reloads on the same tab id", async () => {
    let discoveryCalls = 0;
    let textAttempts = 0;
    const fakeTransport = {
      requireTab: async () => { discoveryCalls += 1; return { id: 11, url: "https://web.whatsapp.com/" }; },
      requireTabId: async (id: number) => ({ id, url: "https://web.whatsapp.com/" }),
      waitForContent: async () => green(),
      send: async (type: InternalMessageType, _payload: unknown, tabId?: number) => {
        expect(tabId).toBe(11);
        if (type === "WA_OPEN_CONVERSATION") return { navigationStarted: true };
        if (type === "WA_PROVE_CONVERSATION") return { verified: true, evidence: "structured-recipient-id", checkedAt: NOW };
        if (type === "WA_SEND_TEXT") {
          textAttempts += 1;
          if (textAttempts === 1) throw new ExtensionError(ERROR_CODES.interfaceLoading, "reloading");
          return { success: true, completedAt: NOW, verification: { confirmed: true, method: "new-outgoing-message-dom" } };
        }
        throw new Error("unexpected");
      }
    };
    const adapter = new ChromeWhatsAppContactAdapter({ getImage: async () => null }, fakeTransport as unknown as WhatsAppTransport);
    const state = checkpoint();
    const context = { checkpoint: state, timeoutMs: 10, imageLoadTimeoutMs: 10, previewTimeoutMs: 10 };
    await adapter.openConversation(state.contact, 10);
    expect(await adapter.sendText(state.steps[1] as never, context)).toMatchObject({ outcome: "failed" });
    expect(await adapter.sendText(state.steps[1] as never, context)).toMatchObject({ outcome: "confirmed" });
    expect(discoveryCalls).toBe(1);
  });
});
