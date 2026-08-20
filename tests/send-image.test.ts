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

function wireWritableFiles(input: HTMLInputElement): () => FileList | null {
  let assignedFiles: FileList | null = null;
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => assignedFiles,
    set: (value: FileList) => { assignedFiles = value; }
  });
  return () => assignedFiles;
}

beforeEach(() => {
  TestDataTransfer.lastFile = null;
  document.body.innerHTML = `
    <div id="main">
      <header data-jid="5491112345678@c.us"></header>
      <div class="message-out" data-id="true_old"><div data-testid="image-thumb"><img src="data:image/png;base64,AA=="></div></div>
      <footer>
        <button type="button" data-testid="clip">Adjuntar</button>
        <input data-testid="photos-videos-input" type="file" accept="image/*,video/mp4,video/3gpp,video/quicktime">
        <div role="textbox" contenteditable="true" data-testid="conversation-compose-box-input"></div>
      </footer>
      <div data-testid="media-editor">
        <button type="button" data-testid="media-editor-send">Enviar</button>
      </div>
    </div>`;
  wireWritableFiles(document.querySelector<HTMLInputElement>("input[type='file']")!);
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
    confirmationTimeoutMs: 500
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

function appendOutgoingPhoto(id: string, src = "blob:photo"): void {
  document.getElementById("main")!.insertAdjacentHTML(
    "beforeend",
    `<div class='message-out' data-id='${id}'><div data-testid='image-thumb'><img src='${src}'></div></div>`
  );
}

describe("verified image send", () => {
  it("confirms only a new outgoing PHOTO node after the preview closes", async () => {
    let checkpointedBeforeClick = false;
    let clickObservedCheckpoint = false;
    document.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => {
      clickObservedCheckpoint = checkpointedBeforeClick;
      appendOutgoingPhoto("true_new_media");
      document.querySelector<HTMLElement>("[data-testid='media-editor']")!.style.display = "none";
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
      confidence: "strong",
      method: "new-outgoing-photo-dom+preview-dismissed",
      outgoingMessageId: "true_new_media"
    });
    expect(result.verification.details).toMatchObject({ expectedOutgoingKind: "photo" });
    expect(clickObservedCheckpoint).toBe(true);
  });

  it("preserves the exact local image bytes, name, type and size before WhatsApp receives the photo", async () => {
    document.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => {
      appendOutgoingPhoto("true_exact_media", "blob:exact");
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
      sourceBytesPreserved: true,
      expectedOutgoingKind: "photo"
    });
  });

  it("chooses the explicit Fotos y videos route instead of a generic sticker-capable image input", async () => {
    document.querySelector("[data-testid='photos-videos-input']")?.remove();
    const footer = document.querySelector("footer")!;
    footer.insertAdjacentHTML("beforeend", `
      <input data-testid="sticker-upload" aria-label="Sticker" type="file" accept="image/*">
      <input data-testid="photo-upload" aria-label="Campaign photo" type="file" accept="image/*">
      <div role="menu" data-testid="attach-menu" hidden>
        <div role="button" tabindex="0">Fotos y videos</div>
      </div>`);
    const stickerInput = document.querySelector<HTMLInputElement>("[data-testid='sticker-upload']")!;
    const photoInput = document.querySelector<HTMLInputElement>("[data-testid='photo-upload']")!;
    const stickerFiles = wireWritableFiles(stickerInput);
    const photoFiles = wireWritableFiles(photoInput);
    const menu = document.querySelector<HTMLElement>("[data-testid='attach-menu']")!;
    document.querySelector<HTMLButtonElement>("[data-testid='clip']")!.addEventListener("click", () => { menu.hidden = false; });
    menu.querySelector<HTMLElement>("[role='button']")!.addEventListener("click", () => { photoInput.click(); });
    document.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => {
      appendOutgoingPhoto("true_photo_route");
      document.querySelector<HTMLElement>("[data-testid='media-editor']")!.style.display = "none";
    });

    const result = await sendAndVerifyImage(imageInput());
    expect(stickerFiles()).toBeNull();
    expect(photoFiles()?.item(0)).toMatchObject({ name: "flor.png", type: "image/png", size: 3 });
    expect(result.verification.details).toMatchObject({
      uploadStrategy: "photo-input.photos-videos-action",
      expectedOutgoingKind: "photo"
    });
  });

  it("never accepts a sticker bubble as confirmation of an image/photo step", async () => {
    document.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => {
      document.getElementById("main")!.insertAdjacentHTML(
        "beforeend",
        "<div class='message-out' data-id='true_sticker'><div data-testid='sticker'><img src='blob:sticker'></div></div>"
      );
      document.querySelector<HTMLElement>("[data-testid='media-editor']")!.style.display = "none";
    });

    await expect(sendAndVerifyImage({ ...imageInput(), confirmationTimeoutMs: 10 }))
      .rejects.toMatchObject({
        code: "AMBIGUOUS_RESULT",
        details: {
          sendAttempted: true,
          expectedOutgoingKind: "photo",
          previewDismissed: true,
          causalPhotoObserved: false
        }
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
      appendOutgoingPhoto("true_current_media", "blob:current");
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
      appendOutgoingPhoto("true_hd_media", "blob:hd");
      editor.style.display = "none";
    });

    const result = await sendAndVerifyImage(imageInput());
    expect(option.getAttribute("aria-checked")).toBe("true");
    expect(result.verification.details).toMatchObject({ qualityMode: "hd_enabled" });
  });

  it("marks the result ambiguous with explicit evidence diagnostics when no outgoing photo is observed", async () => {
    await expect(sendAndVerifyImage({ ...imageInput(), confirmationTimeoutMs: 5 }))
      .rejects.toMatchObject({
        code: "AMBIGUOUS_RESULT",
        details: {
          sendAttempted: true,
          previewDismissed: false,
          causalNewOutgoingBubbleCount: 0,
          causalPhotoObserved: false
        }
      });
  });

  it("fails closed instead of picking an ambiguous generic image uploader", async () => {
    document.querySelector("[data-testid='photos-videos-input']")?.remove();
    document.querySelector("[data-testid='clip']")?.remove();
    document.querySelector("footer")!.insertAdjacentHTML("beforeend", "<input type='file' accept='image/*'>");
    wireWritableFiles(document.querySelector<HTMLInputElement>("footer input[type='file']")!);
    await expect(sendAndVerifyImage(imageInput())).rejects.toMatchObject({
      code: "ATTACHMENT_UNAVAILABLE",
      details: { expectedMediaRoute: "photos_videos", sendAttempted: false }
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
      appendOutgoingPhoto("true_other_chat_media", "blob:other");
      document.querySelector<HTMLElement>("[data-testid='media-editor']")!.style.display = "none";
    });

    await expect(sendAndVerifyImage({ ...imageInput(), confirmationTimeoutMs: 50 }))
      .rejects.toMatchObject({ code: "CONTACT_CONTEXT_UNVERIFIED" });
  });

  it("confirms a newly inserted outgoing photo even when WhatsApp gives it no stable DOM id", async () => {
    document.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => {
      document.getElementById("main")!.insertAdjacentHTML(
        "beforeend",
        "<div class='message-out'><div><img src='blob:test'></div></div>"
      );
      document.querySelector<HTMLElement>("[data-testid='media-editor']")!.style.display = "none";
    });

    const result = await sendAndVerifyImage(imageInput());
    expect(result.verification).toMatchObject({
      outcome: "confirmed",
      confidence: "causal",
      method: "causal-outgoing-photo-mutation+preview-dismissed+composer-ready"
    });
    expect(result.verification.outgoingMessageId).toBeUndefined();
    expect(result.verification.details).toMatchObject({
      photoEvidenceMethod: "causal-outgoing-photo-mutation",
      stablePhotoIdentity: false,
      previewDismissed: true,
      composerRestored: true
    });
  });

  it("keeps causal proof when WhatsApp virtualizes the new photo immediately after inserting it", async () => {
    document.querySelector<HTMLButtonElement>("[data-testid='media-editor-send']")!.addEventListener("click", () => {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = "<div class='message-out'><div><img src='blob:ephemeral'></div></div>";
      const bubble = wrapper.firstElementChild as HTMLElement;
      document.getElementById("main")!.appendChild(bubble);
      document.querySelector<HTMLElement>("[data-testid='media-editor']")!.style.display = "none";
      globalThis.setTimeout(() => bubble.remove(), 0);
    });

    const result = await sendAndVerifyImage(imageInput());
    expect(result.verification).toMatchObject({
      outcome: "confirmed",
      confidence: "causal",
      method: "causal-outgoing-photo-mutation+preview-dismissed+composer-ready"
    });
  });
});