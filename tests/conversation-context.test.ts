// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  proveConversationContext,
  requireConversationContext,
  waitForConversationContext
} from "../src/whatsapp/conversation-context";

describe("ConversationContextProof", () => {
  beforeEach(() => {
    document.body.innerHTML = "<div id='main'><header data-jid='5491112345678@c.us'></header></div>";
  });

  it("WA_PROVE_CONVERSATION accepts the exact structured recipient id without reading visible names", () => {
    document.querySelector("header")!.textContent = "Nombre privado";
    expect(proveConversationContext("5491112345678")).toMatchObject({
      verified: true,
      evidence: "header-recipient-id",
      normalizationApplied: "none"
    });
  });

  it("rejects a different recipient", () => {
    expect(proveConversationContext("5491199999999")).toBeNull();
    expect(() => requireConversationContext("5491199999999")).toThrow(expect.objectContaining({ code: "CONTACT_CONTEXT_UNVERIFIED" }));
  });

  it("waits for the correct chat when strong evidence appears after navigation settles", async () => {
    document.body.innerHTML = "<div id='main'><header>Nombre guardado</header></div>";
    globalThis.setTimeout(() => document.querySelector("header")!.setAttribute("data-jid", "5491112345678@c.us"), 20);
    await expect(waitForConversationContext("5491112345678", { timeoutMs: 250 })).resolves.toMatchObject({ verified: true });
  });

  it("does not pass merely because the composer appears before recipient evidence", async () => {
    document.body.innerHTML = "<div id='main'><header>Nombre guardado</header><footer><div role='textbox' contenteditable='true'></div></footer></div>";
    await expect(waitForConversationContext("5491112345678", { timeoutMs: 30 })).rejects.toMatchObject({ code: "CONTACT_CONTEXT_UNVERIFIED" });
  });

  it("does not depend on /send?phone remaining in the URL after WhatsApp resolves the chat", () => {
    history.replaceState({}, "", "/resolved-chat");
    expect(proveConversationContext("5491112345678")).toMatchObject({ verified: true, evidence: "header-recipient-id" });
  });

  it("uses message JID consensus when a saved contact shows only a name in the header", () => {
    document.body.innerHTML = `
      <div id='main'>
        <header>Cliente guardado</header>
        <div data-id='false_5491112345678@c.us_AAAAA'></div>
        <div data-id='true_5491112345678@c.us_BBBBB'></div>
      </div>`;
    expect(proveConversationContext("5491112345678")).toMatchObject({ verified: true, evidence: "message-jid-consensus" });
  });

  it("accepts only the controlled Argentina 549 ↔ 54 mobile JID equivalence", () => {
    document.body.innerHTML = "<div id='main'><header data-jid='541112345678@c.us'></header></div>";
    expect(proveConversationContext("5491112345678")).toMatchObject({
      verified: true,
      normalizationApplied: "argentina-mobile-9-equivalent"
    });
  });

  it("never accepts a genuinely different Argentine phone", () => {
    document.body.innerHTML = "<div id='main'><header data-jid='541198765432@c.us'></header></div>";
    expect(proveConversationContext("5491112345678")).toBeNull();
  });

  it("fails closed if the user changes to a different chat while proof is waiting", async () => {
    document.body.innerHTML = "<div id='main'><header>Cliente</header></div>";
    globalThis.setTimeout(() => document.querySelector("header")!.setAttribute("data-jid", "5491199999999@c.us"), 10);
    await expect(waitForConversationContext("5491112345678", { timeoutMs: 40 })).rejects.toMatchObject({ code: "CONTACT_CONTEXT_UNVERIFIED" });
  });

  it("rejects conflicting strong identifiers instead of choosing a convenient match", () => {
    document.body.innerHTML = `
      <div id='main'>
        <header data-jid='5491112345678@c.us'><span data-chat-id='5491199999999@c.us'></span></header>
      </div>`;
    expect(proveConversationContext("5491112345678")).toBeNull();
  });

  it("does not let unrelated bare numeric message data-id values poison a valid header proof", () => {
    document.body.innerHTML = `
      <div id='main'>
        <header data-jid='5491112345678@c.us'>Cliente</header>
        <div data-id='123456789012345'></div>
        <div data-id='987654321098765'></div>
      </div>`;
    expect(proveConversationContext("5491112345678")).toMatchObject({ verified: true, evidence: "header-recipient-id" });
  });

  it("supports cancellation while waiting and still fails without sending", async () => {
    document.body.innerHTML = "<div id='main'><header>Cliente</header></div>";
    const controller = new AbortController();
    globalThis.setTimeout(() => controller.abort(), 10);
    await expect(waitForConversationContext("5491112345678", { timeoutMs: 200, signal: controller.signal })).rejects.toMatchObject({
      code: "CONTACT_CONTEXT_UNVERIFIED"
    });
  });
});
