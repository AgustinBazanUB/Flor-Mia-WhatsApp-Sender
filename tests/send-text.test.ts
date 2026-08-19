// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sendAndVerifyText } from "../src/whatsapp/send-text";

beforeEach(() => {
  document.body.innerHTML = `<div id="main"><header data-jid="5491112345678@c.us"></header><div class="messages"><div class="message-out" data-id="true_old"><span class="selectable-text">Anterior</span></div></div><footer><div contenteditable="true" role="textbox" data-testid="conversation-compose-box-input"></div><button type="button" data-testid="compose-btn-send">Enviar</button></footer></div>`;
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
});

function composerText(): string { return document.querySelector<HTMLElement>("[contenteditable='true']")?.textContent ?? ""; }
function appendOutgoing(text: string, id?: string, ancestorId = false): HTMLElement {
  const bubble = document.createElement("div"); bubble.className = "message-out";
  const span = document.createElement("span"); span.className = "selectable-text"; span.textContent = text; bubble.append(span);
  if (id && !ancestorId) bubble.dataset.id = id;
  if (id && ancestorId) { const wrapper = document.createElement("div"); wrapper.dataset.id = id; wrapper.append(bubble); document.querySelector(".messages")!.append(wrapper); }
  else document.querySelector(".messages")!.append(bubble);
  return bubble;
}

describe("post-click text verification 0.9.4.3", () => {
  it("CONFIRMED_STRONG: new exact outgoing with stable id", async () => {
    document.querySelector("button")!.addEventListener("click", () => appendOutgoing(composerText(), "true_new"));
    const result = await sendAndVerifyText({ operationId: "strong", phoneDigits: "5491112345678", message: "Hola Flor Mía", timeoutMs: 200 });
    expect(result.verification).toMatchObject({ confirmed: true, sent: true, outcome: "confirmed_strong", confidence: "strong", method: "new-outgoing-message-stable-dom", messageElementId: "true_new" });
  });

  it("detects a stable data-id on an ancestor of .message-out", async () => {
    document.querySelector("button")!.addEventListener("click", () => appendOutgoing(composerText(), "true_ancestor", true));
    const result = await sendAndVerifyText({ operationId: "ancestor", phoneDigits: "5491112345678", message: "Ancestro", timeoutMs: 200 });
    expect(result.verification).toMatchObject({ outcome: "confirmed_strong", messageElementId: "true_ancestor" });
  });

  it("CONFIRMED_CAUSAL: new exact outgoing without stable id", async () => {
    document.querySelector("button")!.addEventListener("click", () => appendOutgoing(composerText()));
    const result = await sendAndVerifyText({ operationId: "causal", phoneDigits: "5491112345678", message: "Sin ID", timeoutMs: 250 });
    expect(result.verification).toMatchObject({ confirmed: true, sent: true, outcome: "confirmed_causal", confidence: "causal", method: "new-outgoing-node-after-click", newOutgoingObserved: true, exactTextObserved: true });
  });

  it("does not confirm an old identical bubble", async () => {
    document.querySelector(".selectable-text")!.textContent = "Repetido";
    const result = await sendAndVerifyText({ operationId: "old-only", phoneDigits: "5491112345678", message: "Repetido", timeoutMs: 40 });
    expect(result.verification).toMatchObject({ confirmed: false, sent: true, outcome: "sent_unverified", confidence: "unverified" });
  });

  it("old identical + new identical confirms only the new causal node", async () => {
    document.querySelector(".selectable-text")!.textContent = "Repetido";
    document.querySelector("button")!.addEventListener("click", () => appendOutgoing("Repetido"));
    const result = await sendAndVerifyText({ operationId: "repeat-new", phoneDigits: "5491112345678", message: "Repetido", timeoutMs: 200 });
    expect(result.verification.outcome).toBe("confirmed_causal");
  });

  it("a new outgoing with different text never confirms the expected campaign text", async () => {
    document.querySelector("button")!.addEventListener("click", () => appendOutgoing("Texto diferente", "true_other"));
    const result = await sendAndVerifyText({ operationId: "different", phoneDigits: "5491112345678", message: "Texto esperado", timeoutMs: 40 });
    expect(result.verification).toMatchObject({ confirmed: false, sent: true, outcome: "sent_unverified", exactTextObserved: false });
  });

  it("elevates causal evidence when data-id appears milliseconds later", async () => {
    document.querySelector("button")!.addEventListener("click", () => {
      const bubble = appendOutgoing(composerText());
      window.setTimeout(() => { bubble.dataset.id = "true_late"; }, 10);
    });
    const result = await sendAndVerifyText({ operationId: "late-id", phoneDigits: "5491112345678", message: "ID tardío", timeoutMs: 250 });
    expect(result.verification).toMatchObject({ outcome: "confirmed_strong", messageElementId: "true_late" });
  });

  it.each(["Hola, esto es una prueba 👋", "Árbol, pingüino, acción y corazón ❤️", "Línea uno\nLínea dos\nLínea tres", "Símbolos: ¿¡!?#%&/()[]{}—… € $ @"])("matches exact text including unicode and multiline", async (message) => {
    document.querySelector("button")!.addEventListener("click", () => appendOutgoing(composerText()));
    const result = await sendAndVerifyText({ operationId: `exact-${message.length}`, phoneDigits: "5491112345678", message, timeoutMs: 250 });
    expect(result.verification.confirmed).toBe(true);
  });

  it("composer empty by itself never confirms; it becomes SENT_UNVERIFIED", async () => {
    document.querySelector("button")!.addEventListener("click", () => { document.querySelector<HTMLElement>("[contenteditable='true']")!.textContent = ""; });
    const result = await sendAndVerifyText({ operationId: "empty-only", phoneDigits: "5491112345678", message: "Sin bubble", timeoutMs: 40 });
    expect(result.verification).toMatchObject({ outcome: "sent_unverified", composerConsumed: true });
  });

  it("fails closed if recipient changes after click", async () => {
    document.querySelector("button")!.addEventListener("click", () => {
      document.querySelector("header")!.setAttribute("data-jid", "5491188888888@c.us");
      appendOutgoing("Hola Flor Mía");
    });
    await expect(sendAndVerifyText({ operationId: "wrong-after", phoneDigits: "5491112345678", message: "Hola Flor Mía", timeoutMs: 100 }))
      .rejects.toMatchObject({ code: "CONTACT_CONTEXT_UNVERIFIED", details: { sendAttempted: true } });
  });

  it("preserves a different user draft and never clicks", async () => {
    document.querySelector<HTMLElement>("[contenteditable='true']")!.textContent = "Borrador del usuario";
    let clicks = 0; document.querySelector("button")!.addEventListener("click", () => { clicks += 1; });
    await expect(sendAndVerifyText({ operationId: "draft", phoneDigits: "5491112345678", message: "Nuevo", timeoutMs: 50 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(clicks).toBe(0);
  });

  it("revalidates after durable checkpoint and cancels before click on chat change", async () => {
    let clicks = 0; document.querySelector("button")!.addEventListener("click", () => { clicks += 1; });
    await expect(sendAndVerifyText({ operationId: "checkpoint-change", phoneDigits: "5491112345678", message: "No enviar", timeoutMs: 50 }, {
      beforeSend: async () => { document.querySelector("header")!.setAttribute("data-jid", "5491188888888@c.us"); }
    })).rejects.toMatchObject({ code: "CONTACT_CONTEXT_UNVERIFIED" });
    expect(clicks).toBe(0);
  });
});
