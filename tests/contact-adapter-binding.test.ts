import { describe, expect, it } from "vitest";
import { ChromeWhatsAppContactAdapter } from "../src/background/contact-adapter";
import type { WhatsAppTransport } from "../src/background/whatsapp-transport";
import { createUnavailablePreflight } from "../src/compatibility/preflight-result";
import { createContactCheckpoint } from "../src/engine/steps";
import type { ContactCheckpointRepository, ContactProcessCheckpoint } from "../src/engine/types";
import type { InternalMessageType } from "../src/shared/protocol";
import { ERROR_CODES, ExtensionError } from "../src/shared/errors";

const NOW = "2026-08-16T12:00:00.000Z";

function green(contentInstanceId = "content-new") {
  return {
    ...createUnavailablePreflight("GREEN", {}, { pageDetected: true, contentScriptConnected: true }),
    contentInstanceId,
    documentReady: true,
    sessionReady: true,
    mainInterfaceReady: true,
    operational: true,
    overallStatus: "GREEN" as const,
    status: "ready" as const
  };
}

function navigation(contentInstanceId = "content-old", navigationRequestId = "navigation-test") {
  return { navigationStarted: true as const, requestedNavigationAt: NOW, contentInstanceId, navigationRequestId };
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

function memoryCheckpoints(initial: ContactProcessCheckpoint): ContactCheckpointRepository & { active: ContactProcessCheckpoint | null } {
  return {
    active: initial,
    async loadActive() { return this.active; },
    async saveActive(next) { this.active = next; return next; },
    async clearActive() { this.active = null; }
  };
}

describe("active WhatsApp tab binding", () => {
  it("uses the same tab for open, proof, image, text and reconciliation even if discovery order changes", async () => {
    const calls: Array<{ type: InternalMessageType; tabId?: number }> = [];
    let discoveryCalls = 0;
    const fakeTransport = {
      requireTab: async () => { discoveryCalls += 1; return { id: 11, url: "https://web.whatsapp.com/" }; },
      requireTabId: async (id: number) => ({ id, url: "https://web.whatsapp.com/" }),
      waitForContent: async () => green(),
      send: async (type: InternalMessageType, payload: unknown, tabId?: number) => {
        calls.push({ type, tabId });
        if (type === "WA_OPEN_CONVERSATION") {
          const navigationRequestId = (payload as { navigationRequestId: string }).navigationRequestId;
          return navigation("content-old", navigationRequestId);
        }
        if (type === "WA_PROVE_CONVERSATION") return { verified: true, evidence: "header-recipient-id", checkedAt: NOW };
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

  it("passes the old content generation to the handshake and the fresh one to conversation proof", async () => {
    const waitOptions: unknown[] = [];
    let proofPayload: Record<string, unknown> | null = null;
    const fakeTransport = {
      requireTab: async () => ({ id: 11, url: "https://web.whatsapp.com/" }),
      requireTabId: async (id: number) => ({ id, url: "https://web.whatsapp.com/" }),
      waitForContent: async (_tabId: number, _timeout: number, _signal: AbortSignal | undefined, options: unknown) => {
        waitOptions.push(options);
        return green("content-new");
      },
      send: async (type: InternalMessageType, payload: unknown) => {
        if (type === "WA_OPEN_CONVERSATION") {
          const navigationRequestId = (payload as { navigationRequestId: string }).navigationRequestId;
          return navigation("content-old", navigationRequestId);
        }
        if (type === "WA_PROVE_CONVERSATION") {
          proofPayload = payload as Record<string, unknown>;
          return { verified: true, evidence: "header-recipient-id", checkedAt: NOW };
        }
        throw new Error("unexpected");
      }
    };
    const adapter = new ChromeWhatsAppContactAdapter({ getImage: async () => null }, fakeTransport as unknown as WhatsAppTransport);
    await adapter.openConversation(checkpoint().contact, 100);

    expect(waitOptions).toEqual([{ previousContentInstanceId: "content-old", purpose: "content_handshake" }]);
    expect(proofPayload).toMatchObject({ expectedContentInstanceId: "content-new" });
  });

  it("retries only handshake/proof after a transient receiver gap instead of navigating the same contact twice", async () => {
    let navigations = 0;
    let waits = 0;
    const fakeTransport = {
      requireTab: async () => ({ id: 11, url: "https://web.whatsapp.com/" }),
      requireTabId: async (id: number) => ({ id, url: "https://web.whatsapp.com/" }),
      waitForContent: async () => {
        waits += 1;
        if (waits === 1) throw new ExtensionError(ERROR_CODES.interfaceLoading, "receiver changing");
        return green("content-new");
      },
      send: async (type: InternalMessageType, payload: unknown) => {
        if (type === "WA_OPEN_CONVERSATION") {
          navigations += 1;
          const navigationRequestId = (payload as { navigationRequestId: string }).navigationRequestId;
          return navigation("content-old", navigationRequestId);
        }
        if (type === "WA_PROVE_CONVERSATION") return { verified: true, evidence: "header-recipient-id", checkedAt: NOW };
        throw new Error("unexpected");
      }
    };
    const adapter = new ChromeWhatsAppContactAdapter({ getImage: async () => null }, fakeTransport as unknown as WhatsAppTransport);
    const contact = checkpoint().contact;

    await expect(adapter.openConversation(contact, 20)).rejects.toMatchObject({ code: "INTERFACE_LOADING" });
    await adapter.openConversation(contact, 100);

    expect(navigations).toBe(1);
    expect(waits).toBe(2);
  });

  it("persists the tab id before navigation and reuses it after a simulated Service Worker restart", async () => {
    const state = checkpoint();
    const store = memoryCheckpoints(state);
    let discoveryCalls = 0;
    const requiredIds: number[] = [];
    const fakeTransport = {
      requireTab: async () => { discoveryCalls += 1; return { id: discoveryCalls === 1 ? 11 : 22, url: "https://web.whatsapp.com/" }; },
      requireTabId: async (id: number) => { requiredIds.push(id); return { id, url: "https://web.whatsapp.com/" }; },
      waitForContent: async () => green(),
      send: async (type: InternalMessageType, payload: unknown) => type === "WA_OPEN_CONVERSATION"
        ? navigation("content-old", (payload as { navigationRequestId: string }).navigationRequestId)
        : { verified: true, proofLevel: "strong", evidence: "header-recipient-id", checkedAt: NOW }
    };

    const firstAdapter = new ChromeWhatsAppContactAdapter(
      { getImage: async () => null },
      fakeTransport as unknown as WhatsAppTransport,
      store
    );
    await firstAdapter.openConversation(state.contact, 10);
    expect(store.active?.contact.whatsappTabId).toBe(11);

    const recoveredContact = { ...store.active!.contact };
    const recoveredAdapter = new ChromeWhatsAppContactAdapter(
      { getImage: async () => null },
      fakeTransport as unknown as WhatsAppTransport,
      store
    );
    await recoveredAdapter.openConversation(recoveredContact, 10);

    expect(discoveryCalls).toBe(1);
    expect(requiredIds).toEqual([11]);
  });

  it("fails closed after restart when the persisted tab was closed instead of selecting another WhatsApp tab", async () => {
    const state = checkpoint();
    state.contact.whatsappTabId = 11;
    const store = memoryCheckpoints(state);
    let discoveryCalls = 0;
    const fakeTransport = {
      requireTab: async () => { discoveryCalls += 1; return { id: 22, url: "https://web.whatsapp.com/" }; },
      requireTabId: async (id: number) => {
        expect(id).toBe(11);
        throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "closed");
      },
      waitForContent: async () => green(),
      send: async (_type: InternalMessageType, payload: unknown) => navigation("content-old", (payload as { navigationRequestId: string }).navigationRequestId)
    };
    const recoveredAdapter = new ChromeWhatsAppContactAdapter(
      { getImage: async () => null },
      fakeTransport as unknown as WhatsAppTransport,
      store
    );

    await expect(recoveredAdapter.openConversation({ ...state.contact }, 10)).rejects.toMatchObject({ code: "WHATSAPP_NOT_OPEN" });
    expect(discoveryCalls).toBe(0);
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
      send: async (type: InternalMessageType, payload: unknown) => {
        if (!boundOpen) throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "closed");
        if (type === "WA_OPEN_CONVERSATION") {
          const navigationRequestId = (payload as { navigationRequestId: string }).navigationRequestId;
          return navigation("content-old", navigationRequestId);
        }
        return { verified: true, evidence: "header-recipient-id", checkedAt: NOW };
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
      send: async (type: InternalMessageType, payload: unknown, tabId?: number) => {
        expect(tabId).toBe(11);
        if (type === "WA_OPEN_CONVERSATION") {
          const navigationRequestId = (payload as { navigationRequestId: string }).navigationRequestId;
          return navigation("content-old", navigationRequestId);
        }
        if (type === "WA_PROVE_CONVERSATION") return { verified: true, evidence: "header-recipient-id", checkedAt: NOW };
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
