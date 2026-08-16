// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { sendAndVerifyImage } from "../src/whatsapp/send-image";

class TestDataTransfer {
  private readonly transferred: File[] = [];
  readonly items = { add: (file: File) => { this.transferred.push(file); } };
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
  document.body.innerHTML = `
    <div id="main">
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
    imageId: "image-1",
    name: "flor.png",
    type: "image/png",
    size: 3,
    dataBase64: "AQID",
    imageLoadTimeoutMs: 20,
    previewTimeoutMs: 20,
    confirmationTimeoutMs: 20
  };
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

  it("marks the result ambiguous when send was clicked without conclusive DOM evidence", async () => {
    await expect(sendAndVerifyImage({ ...imageInput(), confirmationTimeoutMs: 5 }))
      .rejects.toMatchObject({ code: "AMBIGUOUS_RESULT", details: { sendAttempted: true } });
  });
});
