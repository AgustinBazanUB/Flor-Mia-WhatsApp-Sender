// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://web.whatsapp.com/"}
import { beforeEach, describe, expect, it } from "vitest";
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

describe("contextual WhatsApp preflight", () => {
  beforeEach(() => baseConversation());

  it("keeps a text-only campaign GREEN without multimedia capabilities", async () => {
    document.querySelector("[data-testid='clip']")?.remove();
    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "full",
      requirements: { needsText: true, needsImages: false }
    });
    expect(result.overallStatus).toBe("GREEN");
    expect(result.capabilities.text_send_action.state).toBe("available");
    expect(result.capabilities.attachment_action.required).toBe(false);
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

  it("waits for a required composer while the chat list remains visible during conversation navigation", async () => {
    document.body.innerHTML = `<div data-testid="chat-list"></div><div id="main"></div>`;
    globalThis.setTimeout(() => {
      document.getElementById("main")!.innerHTML = `
        <footer>
          <div role="textbox" contenteditable="true" data-testid="conversation-compose-box-input"></div>
          <button aria-label="Send" data-testid="compose-btn-send"></button>
        </footer>`;
    }, 5);

    const result = await runWhatsAppPreflight({
      timeoutMs: 100,
      level: "full",
      requirements: { needsText: true, needsImages: false }
    });

    expect(result.overallStatus).toBe("GREEN");
    expect(result.capabilities.composer.state).toBe("available");
    expect(result.capabilities.composer.selectedStrategy).toBe("composer.accessibility.textbox");
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
  });

  it("requires multimedia for an image campaign and becomes RED when it is absent", async () => {
    document.querySelector("[data-testid='clip']")?.remove();
    const result = await runWhatsAppPreflight({
      timeoutMs: 10,
      level: "full",
      requirements: { needsText: false, needsImages: true }
    });
    expect(result.overallStatus).toBe("RED");
    expect(result.capabilities.attachment_action.required).toBe(true);
    expect(result.capabilities.attachment_action.state).toBe("unavailable");
  });

  it("completes a full image preflight when preview and send strategies are observable", async () => {
    baseConversation(`
      <input type="file" accept="image/*">
      <div data-testid="media-editor-canvas"></div>
      <button aria-label="Send" data-testid="media-editor-send"></button>`);
    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "full",
      requirements: { needsText: true, needsImages: true }
    });
    expect(result.overallStatus).toBe("GREEN");
    expect(result.capabilities.media_preview.state).toBe("available");
    expect(result.capabilities.media_preview.selectedStrategy).toBe("media-preview.testid.editor-canvas");
    expect(result.capabilities.media_send_action.state).toBe("available");
    expect(result.strategiesUsed.length).toBeGreaterThan(8);
  });

  it("uses a lightweight health check that does not require a real media preview", async () => {
    const result = await runWhatsAppPreflight({
      timeoutMs: 20,
      level: "lightweight",
      requirements: { needsText: true, needsImages: true }
    });
    expect(result.overallStatus).toBe("GREEN");
    expect(result.capabilities.media_preview.required).toBe(false);
    expect(result.capabilities.media_send_action.required).toBe(false);
  });

  it("differentiates a closed session from an incompatible UI", async () => {
    document.body.innerHTML = "<div data-testid='qrcode'></div>";
    const result = await runWhatsAppPreflight({ timeoutMs: 5, requirements: { needsText: false, needsImages: false } });
    expect(result.status).toBe("login_required");
    expect(result.overallStatus).toBe("RED");
    expect(result.capabilities.session.state).toBe("unavailable");
  });
});
