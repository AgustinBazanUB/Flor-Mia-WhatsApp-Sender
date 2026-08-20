// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { sendAndVerifyImage } from "../src/whatsapp/send-image";

class TestDataTransfer {
  static lastFile: File | null = null;
  private readonly transferred: File[] = [];
  readonly items = { add: (file: File) => {
    TestDataTransfer.lastFile = file;
    this.transferred.push(file);
  } };
  get files(): FileList {
    const files = this.transferred;
    return {
      get length() { return files.length; },
      item(index: number) { return files[index] ?? null; },
      [Symbol.iterator]() { return files[Symbol.iterator](); },
      0: files[0]
    } as unknown as FileList;
  }
}

beforeEach(() => {
  TestDataTransfer.lastFile = null;
  document.body.innerHTML = `
    <div id="main">
      <header data-jid="5491112345678@c.us"></header>
      <div class="message-out" data-id="true_old"><img src="data:image/png;base64,AA=="></div>
      <footer>
        <button type="button" data-testid="clip">Adjuntar</button>
        <input type="file" accept="image/*">
      </footer>
      <div data-testid="media-editor">
        <button type="button" data-testid="media-editor-send">Enviar</button>
      </div>
    </div>`;
  const input = document.querySelector<HTMLInputElement>("input[type='file']")!;
  let assignedFiles: FileList | null = null;
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => assignedFiles,
    set: (value: FileList) => { assignedFiles = value; }
  });
  Object.defineProperty(globalThis, "DataTransfer", { value: TestDataTransfer, configurable: true });
});

function imageInput() {
  return {
    operationId: "campaign:contact:image-1",
    expectedPhoneDigits: "5491112345678",
    imageId: "image-1",
    name: "flor.png",
    type: "image/png",
    size: 3,
    dataBase64: "AQID",
    imageLoadTimeoutMs: 100,
    previewTimeoutMs: 100,
    confirmationTimeoutMs: 100
  };
}

function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el archivo de prueba."));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

describe("verified image send", () => {
  it("confirms only a new outgoing media node after the preview closes", async () => {
    let checkpointedBeforeClick = false;
    let clickObservedCheckpoint = false;
    document.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => {
      clickObservedCheckpoint = checkpointedBeforeClick;
      const outgoing = document.createElement("div");
      outgoing.className = "message-out";
      outgoing.dataset.id = "true_new_media";
      outgoing.innerHTML = "<img src='data:image/png;base64,AQID'>";
      document.getElementById("main")!.append(outgoing);
      (document.querySelector<HTMLElement>("[data-testid='media-editor']")!).style.display = "none";
    });

    const result = await sendAndVerifyImage(imageInput(), {
      beforeSend: async (baselineOutgoingIds) => {
        expect(baselineOutgoingIds).toEqual(["true_old"]);
        checkpointedBeforeClick = true;
      }
    });
    expect(result.success).toBe(true);
    expect(result.verification).toMatchObject({
      outcome: "confirmed",
      method: "new-outgoing-media-dom+preview-dismissed",
      outgoingMessageId: "true_new_media"
    });
    expect(clickObservedCheckpoint).toBe(true);
  });

  it("preserves the exact local image bytes, name, type and size before WhatsApp receives the file", async () => {
    document.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => {
      document.getElementById("main")!.insertAdjacentHTML(
        "beforeend",
        "<div class='message-out' data-id='true_exact_media'><img src='blob:exact'></div>"
      );
      document.querySelector<HTMLElement>("[data-testid='media-editor']")!.style.display = "none";
    });

    const result = await sendAndVerifyImage(imageInput());
    const file = TestDataTransfer.lastFile;
    expect(file).not.toBeNull();
    expect(file).toMatchObject({ name: "flor.png", type: "image/png", size: 3 });
    expect([...await readFileBytes(file!)]).toEqual([1, 2, 3]);
    expect(result.verification.details).toMatchObject({
      preparedName: "flor.png",
      preparedType: "image/png",
      preparedSize: 3,
      sourceBytesPreserved: true
    });
  });

  it("resolves the current WhatsApp send glyph when the media action is a role button", async () => {
    const editor = document.querySelector<HTMLElement>("[data-testid='media-editor']")!;
    editor.innerHTML = `
      <div role="button" tabindex="0" aria-label="Send media">
        <span data-icon="wds-ic-send-filled"></span>
      </div>`;
    const currentSend = editor.querySelector<HTMLElement>("[role='button']")!;
    currentSend.addEventListener("click", () => {
      document.getElementById("main")!.insertAdjacentHTML(
        "beforeend",
        "<div class='message-out' data-id='true_current_media'><img src='blob:current'></div>"
      );
      editor.style.display = "none";
    });

    const result = await sendAndVerifyImage(imageInput());
    expect(result.verification.outgoingMessageId).toBe("true_current_media");
    expect(result.verification.details).toMatchObject({
      sendStrategy: "media-send.semantic-preview-scope.2026"
    });
  });

  it("requests HD quality through an explicit menu before sending when WhatsApp exposes it", async () => {
    const editor = document.querySelector<HTMLElement>("[data-testid='media-editor']")!;
    editor.innerHTML = `
      <button type="button" aria-label="HD" aria-haspopup="menu">HD</button>
      <div role="menu" hidden>
        <button type="button" role="menuitemradio">HD quality</button>
        <button type="button" aria-label="Done">Done</button>
      </div>
      <button type="button" data-testid="media-editor-send">Enviar</button>`;
    const menu = editor.querySelector<HTMLElement>("[role='menu']")!;
    const hd = editor.querySelector<HTMLButtonElement>("[aria-label='HD']")!;
    const option = editor.querySelector<HTMLButtonElement>("[role='menuitemradio']")!;
    const done = editor.querySelector<HTMLButtonElement>("[aria-label='Done']")!;
    hd.addEventListener("click", () => { menu.hidden = !menu.hidden; });
    option.addEventListener("click", () => { option.setAttribute("aria-checked", "true"); });
    done.addEventListener("click", () => { menu.hidden = true; });
    editor.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => {
      document.getElementById("main")!.insertAdjacentHTML(
        "beforeend",
        "<div class='message-out' data-id='true_hd_media'><img src='blob:hd'></div>"
      );
      editor.style.display = "none";
    });

    const result = await sendAndVerifyImage(imageInput());
    expect(option.getAttribute("aria-checked")).toBe("true");
    expect(result.verification.details).toMatchObject({ qualityMode: "hd_enabled" });
  });

  it("marks the result ambiguous when send was clicked without conclusive DOM evidence", async () => {
    await expect(sendAndVerifyImage({ ...imageInput(), confirmationTimeoutMs: 5 }))
      .rejects.toMatchObject({ code: "AMBIGUOUS_RESULT", details: { sendAttempted: true } });
  });

  it("reports attachment capability exhaustion before attempting a send", async () => {
    document.querySelector("[data-testid='clip']")?.remove();
    document.querySelector("input[type='file']")?.remove();
    await expect(sendAndVerifyImage(imageInput())).rejects.toMatchObject({
      code: "SELECTOR_STRATEGY_EXHAUSTED",
      details: { compatibilityDiagnostic: { capability: "attachment_action", logicalStep: "image.attachment_action" } }
    });
  });

  it("does not click Image 2 after the user switches chat before the real click", async () => {
    let clicks = 0;
    document.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => { clicks += 1; });
    await expect(sendAndVerifyImage({ ...imageInput(), operationId: "campaign:contact:image-2", imageId: "image-2" }, {
      beforeSend: async () => { document.querySelector("header")!.setAttribute("data-jid", "5491188888888@c.us"); }
    })).rejects.toMatchObject({ code: "CONTACT_CONTEXT_UNVERIFIED" });
    expect(clicks).toBe(0);
  });

  it("fails closed if the active chat changes after the media click while confirmation is pending", async () => {
    document.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => {
      document.querySelector("header")!.setAttribute("data-jid", "5491188888888@c.us");
      document.getElementById("main")!.insertAdjacentHTML(
        "beforeend",
        "<div class='message-out' data-id='true_other_chat_media'><img src='blob:other'></div>"
      );
      document.querySelector<HTMLElement>("[data-testid='media-editor']")!.style.display = "none";
    });

    await expect(sendAndVerifyImage({ ...imageInput(), confirmationTimeoutMs: 50 }))
      .rejects.toMatchObject({ code: "CONTACT_CONTEXT_UNVERIFIED" });
  });

  it("never confirms outgoing media without a stable DOM id", async () => {
    document.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => {
      document.getElementById("main")!.insertAdjacentHTML("beforeend", "<div class='message-out'><img src='blob:test'></div>");
      document.querySelector<HTMLElement>("[data-testid='media-editor']")!.style.display = "none";
    });
    await expect(sendAndVerifyImage({ ...imageInput(), confirmationTimeoutMs: 5 }))
      .rejects.toMatchObject({ code: "AMBIGUOUS_RESULT" });
  });
});
