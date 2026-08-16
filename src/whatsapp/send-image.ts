import type { StepVerification } from "../engine/types";
import { ERROR_CODES, ExtensionError } from "../shared/errors";
import {
  elementVisible,
  findAttachButton,
  findImageFileInput,
  findMediaPreview,
  findMediaSendButton,
  outgoingMediaMessages
} from "./selectors";
import { waitForCondition } from "./wait";

export interface ImageSendInput {
  operationId: string;
  imageId: string;
  name: string;
  type: string;
  size: number;
  dataBase64: string;
  imageLoadTimeoutMs?: number;
  previewTimeoutMs?: number;
  confirmationTimeoutMs?: number;
  checkpointRequired?: boolean;
}

export interface ImageSendResult {
  success: true;
  operationId: string;
  imageId: string;
  startedAt: string;
  completedAt: string;
  verification: StepVerification;
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function setInputFile(input: HTMLInputElement, file: File): void {
  if (typeof DataTransfer !== "function") {
    throw new ExtensionError(ERROR_CODES.attachmentUnavailable, "El navegador no expone DataTransfer para preparar el adjunto.", {
      recoverable: false
    });
  }
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  const prepared = input.files?.item(0);
  if (!prepared || prepared.name !== file.name || prepared.size !== file.size || prepared.type !== file.type) {
    throw new ExtensionError(ERROR_CODES.imageLoadFailed, "El input de WhatsApp no conservó el archivo esperado.");
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function sendAndVerifyImage(
  input: ImageSendInput,
  lifecycle: { beforeSend?: (baselineOutgoingIds: string[]) => Promise<void> } = {}
): Promise<ImageSendResult> {
  const startedAt = new Date().toISOString();
  const imageLoadTimeoutMs = input.imageLoadTimeoutMs ?? 15_000;
  const previewTimeoutMs = input.previewTimeoutMs ?? 20_000;
  const confirmationTimeoutMs = input.confirmationTimeoutMs ?? 30_000;
  const baselineOutgoingIds = outgoingMediaMessages().map((item) => item.identity);
  const before = new Set(baselineOutgoingIds);

  const existingInput = findImageFileInput();
  const attach = findAttachButton();
  if (attach) attach.element.click();
  if (!attach && !existingInput) {
    throw new ExtensionError(ERROR_CODES.attachmentUnavailable, "No se encontró el mecanismo de adjuntos de WhatsApp.");
  }

  const fileInput = existingInput ?? await waitForCondition(() => findImageFileInput(), {
    timeoutMs: imageLoadTimeoutMs,
    description: "el input de imágenes de WhatsApp"
  }).catch((error: unknown) => {
    throw new ExtensionError(ERROR_CODES.attachmentUnavailable, "WhatsApp no expuso un input de imágenes utilizable.", { cause: error });
  });

  const bytes = base64Bytes(input.dataBase64);
  if (bytes.byteLength !== input.size) {
    throw new ExtensionError(ERROR_CODES.imageLoadFailed, "Los bytes de la imagen no coinciden con el tamaño esperado.", {
      details: { imageId: input.imageId, expectedSize: input.size, receivedSize: bytes.byteLength },
      recoverable: false
    });
  }
  const fileBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const file = new File([fileBytes], input.name, { type: input.type, lastModified: Date.now() });
  setInputFile(fileInput.element, file);

  const preview = await waitForCondition(() => findMediaPreview(), {
    timeoutMs: previewTimeoutMs,
    description: "el preview multimedia de WhatsApp"
  }).catch((error: unknown) => {
    throw new ExtensionError(ERROR_CODES.previewUnavailable, "WhatsApp no mostró el preview de la imagen preparada.", {
      details: { imageId: input.imageId, sendAttempted: false },
      cause: error
    });
  });

  const prepared = fileInput.element.files?.item(0);
  if (!prepared || prepared.name !== input.name || prepared.size !== input.size || prepared.type !== input.type) {
    throw new ExtensionError(ERROR_CODES.imageLoadFailed, "El preview no corresponde al archivo que debía enviarse.", {
      details: { imageId: input.imageId, sendAttempted: false }
    });
  }

  const sendButton = await waitForCondition(
    () => findMediaSendButton(preview.element) ?? findMediaSendButton(),
    { timeoutMs: Math.min(previewTimeoutMs, 10_000), description: "la acción de enviar el preview multimedia" }
  );
  if (sendButton.element.disabled || sendButton.element.getAttribute("aria-disabled") === "true") {
    throw new ExtensionError(ERROR_CODES.previewUnavailable, "El botón de envío multimedia está deshabilitado.");
  }

  await lifecycle.beforeSend?.(baselineOutgoingIds);
  sendButton.element.click();
  const verified = await waitForCondition(() => {
    const outgoing = outgoingMediaMessages().find((item) => !before.has(item.identity));
    return outgoing && !elementVisible(preview.element) ? outgoing : null;
  }, {
    timeoutMs: confirmationTimeoutMs,
    description: "el nuevo mensaje multimedia saliente y el cierre de su preview"
  }).catch((error: unknown) => {
    throw new ExtensionError(ERROR_CODES.ambiguousResult, "Se accionó enviar, pero no se pudo confirmar el resultado multimedia.", {
      details: {
        imageId: input.imageId,
        sendAttempted: true,
        baselineOutgoingIds,
        previewSelector: preview.selector
      },
      cause: error
    });
  });

  return {
    success: true,
    operationId: input.operationId,
    imageId: input.imageId,
    startedAt,
    completedAt: new Date().toISOString(),
    verification: {
      outcome: "confirmed",
      method: "new-outgoing-media-dom+preview-dismissed",
      observedAt: new Date().toISOString(),
      sendAttempted: true,
      outgoingMessageId: verified.identity,
      baselineOutgoingIds,
      details: {
        inputSelector: fileInput.selector,
        previewSelector: preview.selector,
        sendSelector: sendButton.selector,
        preparedName: input.name,
        preparedSize: input.size,
        preparedType: input.type
      }
    }
  };
}
