// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { proveConversationContext, requireConversationContext } from "../src/whatsapp/conversation-context";

describe("ConversationContextProof", () => {
  beforeEach(() => {
    document.body.innerHTML = "<div id='main'><header data-jid='5491112345678@c.us'></header></div>";
  });

  it("proves only the exact structured recipient id without reading visible names", () => {
    document.querySelector("header")!.textContent = "Nombre privado";
    expect(proveConversationContext("5491112345678")).toMatchObject({ verified: true, evidence: "structured-recipient-id" });
  });

  it("fails closed for a different recipient, conflicting ids or insufficient evidence", () => {
    expect(proveConversationContext("5491199999999")).toBeNull();
    document.getElementById("main")!.insertAdjacentHTML("beforeend", "<div data-chat-id='5491188888888@c.us'></div>");
    expect(proveConversationContext("5491112345678")).toBeNull();
    document.body.innerHTML = "<div id='main'><header>Solo nombre visual</header></div>";
    expect(() => requireConversationContext("5491112345678")).toThrow(expect.objectContaining({ code: "CONTACT_CONTEXT_UNVERIFIED" }));
  });
});
