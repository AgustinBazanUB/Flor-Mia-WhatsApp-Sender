// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { reconcileWhatsAppStep } from "../src/whatsapp/reconcile";

beforeEach(() => {
  document.body.innerHTML = "<div id='main'></div>";
});

describe("ambiguous result reconciliation", () => {
  it("confirms a new matching outgoing text without re-sending", async () => {
    document.getElementById("main")!.innerHTML = `
      <div class="message-out" data-id="true_new"><span class="selectable-text">Hola Flor Mía</span></div>`;
    const result = await reconcileWhatsAppStep({
      kind: "text",
      operationId: "operation-text",
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
      baselineOutgoingIds: [],
      timeoutMs: 5
    });
    expect(result).toMatchObject({ outcome: "not_sent", verification: { sendAttempted: false } });
  });

  it("stays ambiguous when the DOM has neither outgoing evidence nor an unsent draft", async () => {
    const result = await reconcileWhatsAppStep({
      kind: "image",
      operationId: "operation-image",
      baselineOutgoingIds: [],
      timeoutMs: 5
    });
    expect(result).toMatchObject({ outcome: "ambiguous", verification: { method: "no-conclusive-dom-evidence" } });
  });
});
