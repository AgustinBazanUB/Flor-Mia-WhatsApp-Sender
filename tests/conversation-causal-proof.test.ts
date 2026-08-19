// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  proveConversationContext,
  requireConversationContext,
  waitForConversationContext,
  type CausalNavigationContext
} from "../src/whatsapp/conversation-context";
import {
  notePotentialManualConversationNavigation,
  resetConversationGuardForTesting
} from "../src/whatsapp/conversation-guard";

const EXPECTED = "5491112345678";
const causal = (overrides: Partial<CausalNavigationContext> = {}): CausalNavigationContext => ({
  navigationRequestId: "navigation-1",
  contentInstanceId: "content-new",
  requestedNavigationAt: "2026-08-19T03:00:00.000Z",
  navigationObservedAt: "2026-08-19T03:00:00.500Z",
  ...overrides
});

function namedConversation(name = "Cliente guardado"): void {
  document.body.innerHTML = `<div id="main"><header>${name}</header><footer><div role="textbox" contenteditable="true"></div></footer></div>`;
}

describe("causal conversation proof", () => {
  beforeEach(() => {
    resetConversationGuardForTesting();
    history.replaceState({}, "", "/resolved-chat");
    namedConversation();
  });

  it("accepts a saved contact name only with a complete causal navigation chain", () => {
    expect(proveConversationContext(EXPECTED, document, causal())).toMatchObject({
      verified: true,
      proofLevel: "causal",
      evidence: "causal-navigation",
      navigationRequestId: "navigation-1"
    });
  });

  it("does not accept name plus composer without causal metadata", () => {
    expect(proveConversationContext(EXPECTED)).toBeNull();
  });

  it("treats an exact retained /send phone as strong proof", () => {
    history.replaceState({}, "", `/send?phone=${EXPECTED}&type=phone_number`);
    expect(proveConversationContext(EXPECTED, document, causal())).toMatchObject({
      proofLevel: "strong",
      evidence: "url-recipient-phone"
    });
  });

  it("rejects a different retained /send phone", () => {
    history.replaceState({}, "", "/send?phone=5491199999999");
    expect(proveConversationContext(EXPECTED, document, causal())).toBeNull();
  });

  it("rejects a stale navigation chronology", () => {
    expect(proveConversationContext(EXPECTED, document, causal({
      requestedNavigationAt: "2026-08-19T03:00:01.000Z",
      navigationObservedAt: "2026-08-19T03:00:00.000Z"
    }))).toBeNull();
  });

  it("rejects an invalid-phone banner without waiting another identical proof", async () => {
    document.body.insertAdjacentHTML("beforeend", "<div role='dialog'><div data-testid='invalid-number'></div></div>");
    await expect(waitForConversationContext(EXPECTED, { timeoutMs: 250, causalNavigation: causal() })).rejects.toMatchObject({
      code: "CONTACT_CONTEXT_UNVERIFIED",
      details: expect.objectContaining({ proofFailureReason: "invalid_phone", retryWithoutNewEvidence: false })
    });
  });

  it("rejects a different strong chat identifier", () => {
    document.querySelector("header")!.setAttribute("data-jid", "5491199999999@c.us");
    expect(proveConversationContext(EXPECTED, document, causal())).toBeNull();
  });

  it("invalidates a causal lease after a manual chat-navigation signal", () => {
    expect(proveConversationContext(EXPECTED, document, causal())).toMatchObject({ proofLevel: "causal" });
    notePotentialManualConversationNavigation();
    expect(() => requireConversationContext(EXPECTED)).toThrow(expect.objectContaining({ code: "CONTACT_CONTEXT_UNVERIFIED" }));
  });

  it("invalidates a causal lease when the conversation fingerprint changes before Send", () => {
    expect(proveConversationContext(EXPECTED, document, causal())).toMatchObject({ proofLevel: "causal" });
    document.querySelector("header")!.textContent = "Otro contacto";
    expect(() => requireConversationContext(EXPECTED)).toThrow(expect.objectContaining({ code: "CONTACT_CONTEXT_UNVERIFIED" }));
  });
});
