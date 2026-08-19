// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://web.whatsapp.com/"}
import { beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runWhatsAppPreflight } from "../src/whatsapp/preflight";

function baseConversation(extra = ""): void {
  document.body.innerHTML = `
    <div data-testid="chat-list"></div>
    <div id="main">
      <footer>
        <div role="textbox" contenteditable="true" data-testid="conversation-compose-box-input"></div>
        <button aria-label="Send" data-testid="compose-btn-send"></button>
        <button aria-label="Attach" data-testid="clip"></button>
        ${extra}
      </footer>
    </div>`;
}

describe("non-destructive WhatsApp preflight", () => {
  beforeEach(() => baseConversation());

  it("keeps a text campaign GREEN without writing synthetic content", async () => {
    document.querySelector("[data-testid='clip']")?.remove();
    const composer = document.querySelector<HTMLElement>("[role='textbox']")!;
    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "full",
      purpose: "campaign_start",
      requirements: { needsText: true, needsImages: false }
    });
    expect(result.overallStatus).toBe("GREEN");
    expect(result.requirements).toEqual({ needsText: true, needsImages: false });
    expect(result.capabilities.text_send_action.required).toBe(false);
    expect(result.capabilities.text_send_action.state).toBe("not_tested");
    expect(result.capabilities.attachment_action.required).toBe(false);
    expect(result.diagnosticComposerMutationDetected).toBe(false);
    expect(composer.textContent).toBe("");
  });

  it("preserves an existing user draft byte-for-byte during full preflight", async () => {
    const composer = document.querySelector<HTMLElement>("[role='textbox']")!;
    const draft = "Borrador del usuario 👋\nNo tocar áéíóú";
    composer.textContent = draft;

    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "full",
      purpose: "campaign_start",
      requirements: { needsText: true, needsImages: false }
    });

    expect(result.overallStatus).toBe("GREEN");
    expect(result.diagnosticComposerMutationDetected).toBe(false);
    expect(composer.textContent).toBe(draft);
  });

  it("accepts a verified WhatsApp semantic surface even while readyState still reports loading", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(document, "readyState");
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
    try {
      const result = await runWhatsAppPreflight({
        timeoutMs: 20,
        level: "full",
        requirements: { needsText: true, needsImages: false }
      });
      expect(result.overallStatus).toBe("GREEN");
      expect(result.documentReady).toBe(true);
      expect(result.capabilities.document_ready.selectedStrategy).toBe("document.semantic-surface");
      expect(result.status).toBe("ready");
    } finally {
      if (originalDescriptor) Object.defineProperty(document, "readyState", originalDescriptor);
      else delete (document as unknown as { readyState?: string }).readyState;
    }
  });

  it("does not require or inspect a conversation during campaign-start preflight", async () => {
    document.body.innerHTML = `<div data-testid="chat-list"></div>`;

    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "full",
      purpose: "campaign_start",
      requirements: { needsText: true, needsImages: false }
    });

    expect(result.overallStatus).toBe("GREEN");
    expect(result.requirements.needsText).toBe(true);
    expect(result.capabilities.composer.required).toBe(false);
    expect(result.capabilities.composer.state).toBe("not_tested");
    expect(result.capabilities.text_send_action.state).toBe("not_tested");
  });

  it("remains GREEN when a primary strategy is disabled and a fallback works", async () => {
    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "full",
      requirements: { needsText: false, needsImages: false },
      developmentFault: "primary_strategy_unavailable"
    });
    expect(result.overallStatus).toBe("GREEN");
    expect(result.capabilities.main_interface.selectedStrategy).toBe("main.testid.chat-list");
    expect(result.capabilities.main_interface.attempts[0]?.result).toBe("disabled");
  });

  it("does not mutate the composer when text capabilities are not required", async () => {
    document.querySelector("[aria-label='Send']")?.remove();
    const composer = document.querySelector<HTMLElement>("[role='textbox']")!;
    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "full",
      requirements: { needsText: false, needsImages: false }
    });
    expect(result.overallStatus).toBe("GREEN");
    expect(composer.textContent).toBe("");
    expect(result.capabilities.text_send_action.required).toBe(false);
    expect(result.capabilities.text_send_action.state).toBe("not_tested");
  });

  it("does not require or click the attachment action for an image campaign startup", async () => {
    document.querySelector("[data-testid='clip']")?.remove();
    const result = await runWhatsAppPreflight({
      timeoutMs: 10,
      level: "full",
      purpose: "campaign_start",
      requirements: { needsText: false, needsImages: true }
    });
    expect(result.overallStatus).toBe("GREEN");
    expect(result.capabilities.attachment_action.required).toBe(false);
    expect(result.capabilities.attachment_action.state).toBe("not_tested");
    expect(result.requirements.needsImages).toBe(true);
  });

  it("does not inject a diagnostic image before a real image send", async () => {
    baseConversation(`<input type="file" accept="image/*">`);
    const fileInput = document.querySelector<HTMLInputElement>("input[type='file']")!;
    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "full",
      requirements: { needsText: true, needsImages: true },
      probeImage: {
        name: "probe.png",
        type: "image/png",
        size: 1,
        dataBase64: "AA=="
      }
    });
    expect(result.overallStatus).toBe("GREEN");
    expect(result.capabilities.media_preview.required).toBe(false);
    expect(result.capabilities.media_preview.state).toBe("not_tested");
    expect(result.capabilities.media_send_action.required).toBe(false);
    expect(result.capabilities.image_file_input.required).toBe(false);
    expect(fileInput.files?.length ?? 0).toBe(0);
    expect(document.querySelector("[data-testid='media-editor-canvas']")).toBeNull();
  });

  it("manual diagnostics can observe an already-open media preview without opening one", async () => {
    baseConversation(`
      <input type="file" accept="image/*">
      <div data-testid="media-editor-canvas"></div>
      <button aria-label="Send" data-testid="media-editor-send"></button>`);
    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "full",
      purpose: "manual_diagnostic",
      requirements: { needsText: true, needsImages: true }
    });
    expect(result.overallStatus).toBe("GREEN");
    expect(result.capabilities.media_preview.state).toBe("available");
    expect(result.capabilities.media_preview.required).toBe(false);
    expect(result.capabilities.media_preview.selectedStrategy).toBe("media-preview.testid.editor-canvas");
    expect(result.capabilities.media_send_action.state).toBe("available");
    expect(result.capabilities.media_send_action.required).toBe(false);
  });

  it("uses a lightweight health check that does not inspect conversation capabilities", async () => {
    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "lightweight",
      purpose: "health_check",
      requirements: { needsText: true, needsImages: true }
    });
    expect(result.overallStatus).toBe("GREEN");
    expect(result.capabilities.media_preview.state).toBe("not_tested");
    expect(result.capabilities.media_send_action.state).toBe("not_tested");
    expect(result.capabilities.text_send_action.state).toBe("not_tested");
  });

  it("manual targeted capability checks remain non-destructive when context is insufficient", async () => {
    document.querySelector("[aria-label='Send']")?.remove();
    const composer = document.querySelector<HTMLElement>("[role='textbox']")!;
    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "targeted",
      purpose: "manual_diagnostic",
      targetedCapability: "text_send_action",
      requirements: { needsText: false, needsImages: false }
    });
    expect(result.overallStatus).toBe("RED");
    expect(result.capabilities.text_send_action.required).toBe(true);
    expect(result.capabilities.text_send_action.state).toBe("requires_context");
    expect(composer.textContent).toBe("");
  });

  it("contains no legacy synthetic composer phrase in production preflight source", async () => {
    const source = await readFile(resolve(process.cwd(), "src/whatsapp/preflight.ts"), "utf8");
    const forbidden = ["Diagnóstico", "Flor", "Mía"].join(" ");
    expect(source).not.toContain(forbidden);
    expect(source).not.toContain("replaceChildren(document.createTextNode");
    expect(source).not.toContain("DataTransfer");
  });

  it("differentiates a closed session from an incompatible UI", async () => {
    document.body.innerHTML = "<div data-testid='qrcode'></div>";
    const result = await runWhatsAppPreflight({ timeoutMs: 5, requirements: { needsText: false, needsImages: false } });
    expect(result.status).toBe("login_required");
    expect(result.overallStatus).toBe("RED");
    expect(result.capabilities.session.state).toBe("unavailable");
  });
});
