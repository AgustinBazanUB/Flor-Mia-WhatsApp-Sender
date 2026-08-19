// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sendAndVerifyText } from "../src/whatsapp/send-text";

beforeEach(() => {
  document.body.innerHTML = `
    <div id="main">
      <header data-jid="5491112345678@c.us"></header>
      <div class="message-out" data-id="true_old"><span class="selectable-text">Anterior</span></div>
      <footer>
        <div contenteditable="true" role="textbox" data-testid="conversation-compose-box-input"></div>
        <button type="button" data-testid="compose-btn-send">Enviar</button>
      </footer>
    </div>`;
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
});

function echoComposerAsOutgoing(id: string, onClick?: (exactComposerText: string) => void): void {
  document.querySelector("button")!.addEventListener("click", () => {
    const composer = document.querySelector<HTMLElement>("[contenteditable='true']")!;
    const exact = composer.textContent ?? "";
    onClick?.(exact);
    const outgoing = document.createElement("div");
    outgoing.className = "message-out";
    outgoing.dataset.id = id;
    const text = document.createElement("span");
    text.className = "selectable-text";
    text.textContent = exact;
    outgoing.append(text);
    document.getElementById("main")!.append(outgoing);
  });
}

describe("verified text send", () => {
  it("returns success only after a new matching outgoing message exists", async () => {
    echoComposerAsOutgoing("true_new");
    const result = await sendAndVerifyText({ operationId: "operation-1", phoneDigits: "5491112345678", message: "Hola Flor Mía", timeoutMs: 100 });
    expect(result.success).toBe(true);
    expect(result.verification).toMatchObject({ confirmed: true, method: "new-outgoing-message-dom", messageElementId: "true_new" });
    expect(result.contactId).not.toContain("5491112345678");
  });

  it.each([
    "Hola, esto es una prueba 👋",
    "Árbol, pingüino, acción y corazón ❤️",
    "Línea uno\nLínea dos\nLínea tres",
    "  conserva espacios exteriores  ",
    "Símbolos: ¿¡!?#%&/()[]{}—… € $ @",
    "x".repeat(4_000)
  ])("places the exact campaign string in the composer before Send", async (message) => {
    let observedBeforeClick: string | null = null;
    echoComposerAsOutgoing("true_exact", (text) => { observedBeforeClick = text; });

    const result = await sendAndVerifyText({
      operationId: `exact-${message.length}`,
      phoneDigits: "5491112345678",
      message,
      timeoutMs: 100
    });

    expect(observedBeforeClick).toBe(message);
    expect(result.success).toBe(true);
  });

  it("normalizes only CRLF line endings before writing to a browser contenteditable", async () => {
    const message = "Línea uno\r\nLínea dos";
    let observedBeforeClick: string | null = null;
    echoComposerAsOutgoing("true_crlf", (text) => { observedBeforeClick = text; });

    await sendAndVerifyText({ operationId: "crlf", phoneDigits: "5491112345678", message, timeoutMs: 100 });
    expect(observedBeforeClick).toBe("Línea uno\nLínea dos");
  });

  it("does not report success without DOM verification", async () => {
    await expect(sendAndVerifyText({ operationId: "operation-2", phoneDigits: "5491112345678", message: "Sin confirmación", timeoutMs: 10 }))
      .rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
  });

  it("preserves an existing draft by refusing to overwrite it", async () => {
    document.querySelector<HTMLElement>("[contenteditable='true']")!.textContent = "Borrador del usuario";
    await expect(sendAndVerifyText({ operationId: "operation-3", phoneDigits: "5491112345678", message: "Nuevo", timeoutMs: 10 }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("cancels before click if another actor mutates the composer after the durable checkpoint", async () => {
    let clicks = 0;
    document.querySelector("button")!.addEventListener("click", () => { clicks += 1; });
    await expect(sendAndVerifyText(
      { operationId: "composer-changed", phoneDigits: "5491112345678", message: "Contenido correcto", timeoutMs: 30 },
      { beforeSend: async () => { document.querySelector<HTMLElement>("[contenteditable='true']")!.textContent = "Contenido distinto"; } }
    )).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
      details: { sendAttempted: false }
    });
    expect(clicks).toBe(0);
  });

  it("returns a targeted sanitized diagnostic when composer strategies are exhausted", async () => {
    document.querySelector("[contenteditable='true']")?.remove();
    await expect(sendAndVerifyText({ operationId: "operation-4", phoneDigits: "5491112345678", message: "Nuevo", timeoutMs: 5 }))
      .rejects.toMatchObject({
        code: "SELECTOR_STRATEGY_EXHAUSTED",
        details: { compatibilityDiagnostic: { capability: "composer", logicalStep: "conversation.composer" } }
      });
  });

  it("refuses to click when the active recipient is wrong", async () => {
    document.querySelector("header")!.setAttribute("data-jid", "5491199999999@c.us");
    let clicks = 0;
    document.querySelector("button")!.addEventListener("click", () => { clicks += 1; });
    await expect(sendAndVerifyText({ operationId: "wrong", phoneDigits: "5491112345678", message: "No enviar", timeoutMs: 5 }))
      .rejects.toMatchObject({ code: "CONTACT_CONTEXT_UNVERIFIED" });
    expect(clicks).toBe(0);
  });

  it("revalidates after the durable pre-click checkpoint and detects a manual chat change", async () => {
    let clicks = 0;
    document.querySelector("button")!.addEventListener("click", () => { clicks += 1; });
    await expect(sendAndVerifyText(
      { operationId: "changed", phoneDigits: "5491112345678", message: "No enviar", timeoutMs: 5 },
      { beforeSend: async () => { document.querySelector("header")!.setAttribute("data-jid", "5491188888888@c.us"); } }
    )).rejects.toMatchObject({ code: "CONTACT_CONTEXT_UNVERIFIED" });
    expect(clicks).toBe(0);
  });

  it("fails closed if the active chat changes after click while outgoing confirmation is pending", async () => {
    document.querySelector("button")!.addEventListener("click", () => {
      document.querySelector("header")!.setAttribute("data-jid", "5491188888888@c.us");
      document.getElementById("main")!.insertAdjacentHTML(
        "beforeend",
        "<div class='message-out' data-id='true_other_chat'><span class='selectable-text'>Hola Flor Mía</span></div>"
      );
    });

    await expect(sendAndVerifyText({
      operationId: "changed-after-click",
      phoneDigits: "5491112345678",
      message: "Hola Flor Mía",
      timeoutMs: 50
    })).rejects.toMatchObject({ code: "CONTACT_CONTEXT_UNVERIFIED" });
  });

  it("never confirms a matching outgoing node without a stable DOM id", async () => {
    document.querySelector("button")!.addEventListener("click", () => {
      document.getElementById("main")!.insertAdjacentHTML("beforeend", "<div class='message-out'><span class='selectable-text'>Sin ID</span></div>");
    });
    await expect(sendAndVerifyText({ operationId: "unstable", phoneDigits: "5491112345678", message: "Sin ID", timeoutMs: 5 }))
      .rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
  });

  it("distinguishes a new stable message from an older identical message", async () => {
    document.querySelector(".selectable-text")!.textContent = "Repetido";
    echoComposerAsOutgoing("true_new_repeat");
    const result = await sendAndVerifyText({ operationId: "repeat", phoneDigits: "5491112345678", message: "Repetido", timeoutMs: 20 });
    expect(result.verification.messageElementId).toBe("true_new_repeat");
  });
});
