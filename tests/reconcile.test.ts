// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { reconcileWhatsAppStep } from "../src/whatsapp/reconcile";

beforeEach(() => {
  document.body.innerHTML = "<div id='main'><header data-jid='5491112345678@c.us'></header></div>";
});

describe("ambiguous result reconciliation", () => {
  it("confirms a new matching outgoing text without re-sending", async () => {
    document.getElementById("main")!.insertAdjacentHTML("beforeend", `
      <div class="message-out" data-id="true_new"><span class="selectable-text">Hola Flor Mía</span></div>`);
    const result = await reconcileWhatsAppStep({
      kind: "text",
      operationId: "operation-text",
      expectedPhoneDigits: "5491112345678",
      baselineOutgoingIds: ["true_old"],
      message: "Hola Flor Mía",
      timeoutMs: 5
    });
    expect(result).toMatchObject({ outcome: "confirmed", verification: { outgoingMessageId: "true_new" } });
  });

  it("classifies an image as not sent when its preview is still actionable", async () => {
    document.getElementById("main")!.insertAdjacentHTML("afterend", `
      <div data-testid="media-editor"><button data-testid="media-editor-send">Enviar</button></div>`);
    const result = await reconcileWhatsAppStep({
      kind: "image",
      operationId: "operation-image",
      expectedPhoneDigits: "5491112345678",
      baselineOutgoingIds: [],
      timeoutMs: 5
    });
    expect(result).toMatchObject({ outcome: "not_sent", verification: { sendAttempted: false } });
  });

  it("stays ambiguous when the DOM has neither outgoing evidence nor an unsent draft", async () => {
    const result = await reconcileWhatsAppStep({
      kind: "image",
      operationId: "operation-image",
      expectedPhoneDigits: "5491112345678",
      baselineOutgoingIds: [],
      timeoutMs: 5
    });
    expect(result).toMatchObject({ outcome: "ambiguous", verification: { method: "no-conclusive-dom-evidence" } });
  });

  it("refuses to inspect another chat during reconciliation", async () => {
    document.querySelector("header")!.setAttribute("data-jid", "5491199999999@c.us");
    document.getElementById("main")!.insertAdjacentHTML("beforeend", "<div class='message-out' data-id='true_new'><span>Hola</span></div>");
    await expect(reconcileWhatsAppStep({
      kind: "text",
      operationId: "wrong-chat",
      expectedPhoneDigits: "5491112345678",
      baselineOutgoingIds: [],
      message: "Hola",
      timeoutMs: 5
    })).rejects.toMatchObject({ code: "CONTACT_CONTEXT_UNVERIFIED" });
  });

  it("keeps reconciliation ambiguous when matching evidence lacks a stable id", async () => {
    document.getElementById("main")!.insertAdjacentHTML("beforeend", "<div class='message-out'><span class='selectable-text'>Hola Flor Mía</span></div>");
    const result = await reconcileWhatsAppStep({
      kind: "text",
      operationId: "unstable",
      expectedPhoneDigits: "5491112345678",
      baselineOutgoingIds: [],
      message: "Hola Flor Mía",
      timeoutMs: 5
    });
    expect(result.outcome).toBe("ambiguous");
  });

  it("does not false-confirm after virtualization removes a stable baseline and inserts an unstable clone", async () => {
    document.getElementById("main")!.insertAdjacentHTML(
      "beforeend",
      "<div class='message-out'><span class='selectable-text'>Mismo texto</span></div>"
    );
    const result = await reconcileWhatsAppStep({
      kind: "text",
      operationId: "virtualized",
      expectedPhoneDigits: "5491112345678",
      baselineOutgoingIds: ["true_removed_by_virtualization"],
      message: "Mismo texto",
      timeoutMs: 5
    });
    expect(result.outcome).toBe("ambiguous");
  });

  it("ignores DOM reorder when every stable media id was already in the baseline", async () => {
    document.getElementById("main")!.insertAdjacentHTML(
      "beforeend",
      "<div class='message-out' data-id='true_media_2'><img src='blob:2'></div><div class='message-out' data-id='true_media_1'><img src='blob:1'></div>"
    );
    const result = await reconcileWhatsAppStep({
      kind: "image",
      operationId: "reordered-media",
      expectedPhoneDigits: "5491112345678",
      baselineOutgoingIds: ["true_media_1", "true_media_2"],
      timeoutMs: 5
    });
    expect(result.outcome).toBe("ambiguous");
  });

  it("confirms only the second image when it has a new stable identity", async () => {
    document.getElementById("main")!.insertAdjacentHTML(
      "beforeend",
      "<div class='message-out' data-id='true_media_old'><img src='blob:old'></div><div class='message-out' data-id='true_media_new'><img src='blob:new'></div>"
    );
    const result = await reconcileWhatsAppStep({
      kind: "image",
      operationId: "two-images",
      expectedPhoneDigits: "5491112345678",
      baselineOutgoingIds: ["true_media_old"],
      timeoutMs: 5
    });
    expect(result).toMatchObject({ outcome: "confirmed", verification: { outgoingMessageId: "true_media_new" } });
  });
});
