// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sendAndVerifyText } from "../src/whatsapp/send-text";

beforeEach(() => {
  document.body.innerHTML = `
    <div id="main">
      <div class="message-out" data-id="true_old"><span class="selectable-text">Anterior</span></div>
      <footer>
        <div contenteditable="true" role="textbox" data-testid="conversation-compose-box-input"></div>
        <button type="button" data-testid="compose-btn-send">Enviar</button>
      </footer>
    </div>`;
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
});

describe("verified text send", () => {
  it("returns success only after a new matching outgoing message exists", async () => {
    document.querySelector("button")!.addEventListener("click", () => {
      const outgoing = document.createElement("div");
      outgoing.className = "message-out";
      outgoing.dataset.id = "true_new";
      outgoing.innerHTML = "<span class='selectable-text'>Hola Flor Mía</span>";
      document.getElementById("main")!.append(outgoing);
    });
    const result = await sendAndVerifyText({ operationId: "operation-1", phoneDigits: "5491112345678", message: "Hola Flor Mía", timeoutMs: 100 });
    expect(result.success).toBe(true);
    expect(result.verification).toMatchObject({ confirmed: true, method: "new-outgoing-message-dom", messageElementId: "true_new" });
    expect(result.contactId).not.toContain("5491112345678");
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
});
