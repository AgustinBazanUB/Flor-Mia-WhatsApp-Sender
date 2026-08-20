import type { StepVerification } from "../engine/types";
import { ERROR_CODES, ExtensionError, toExtensionError } from "../shared/errors";
import { capabilityResolutionError, capabilityUnavailableError } from "../compatibility/diagnostic-error";
import {
  elementVisible,
  findImageFileInput,
  findMediaPreview,
  findMediaSendButton,
  outgoingMediaMessages,
  resolveCapability,
  type SelectorMatch
} from "./selectors";
import { waitForCondition } from "./wait";
import { requireConversationContext } from "./conversation-context";

export interface ImageSendInput {
  operationId: string;
  expectedPhoneDigits: string;
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

type MediaQualityResult = "hd_enabled" | "hd_already_enabled" | "hd_unavailable" | "hd_not_confirmed";

const MEDIA_SEND_FALLBACK_SELECTORS = [
  "button[aria-label='Send']",
  "button[aria-label='Enviar']",
  "[role='button'][aria-label='Send']",
  "[role='button'][aria-label='Enviar']",
  "button[title='Send']",
  "button[title='Enviar']",
  "[role='button'][title='Send']",
  "[role='button'][title='Enviar']",
  "[data-testid='media-editor-send']",
  "[data-testid='compose-btn-send']",
  "[data-icon='send']",
  "[data-icon='wds-ic-send-filled']",
  "[data-icon*='send']"
] as const;

const HD_CONTROL_SELECTORS = [
  "button[aria-label='HD']",
  "[role='button'][aria-label='HD']",
  "button[title='HD']",
  "[role='button'][title='HD']",
  "[data-testid*='hd']",
  "[data-icon*='hd']"
] as const;

const HD_OPTION_LABELS = new Set(["hd quality", "calidad hd", "qualidade hd"]);
const DONE_LABELS = new Set(["done", "listo", "pronto"]);

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

function actionableElement(raw: Element): HTMLElement | null {
  if (raw instanceof HTMLButtonElement) return raw;
  if (raw instanceof HTMLElement && raw.getAttribute("role") === "button") return raw;
  const closest = raw.closest("button, [role='button']");
  return closest instanceof HTMLElement ? closest : null;
}

function previewSearchRoots(previewElement: HTMLElement): HTMLElement[] {
  const roots: HTMLElement[] = [];
  let current: HTMLElement | null = previewElement;
  for (let depth = 0; current && depth < 9; depth += 1) {
    roots.push(current);
    if (current.id === "app" || current === document.body) break;
    current = current.parentElement;
  }
  return roots;
}

function visibleUniqueActions(root: ParentNode, selectors: readonly string[], excludeFooter = true): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const actions: HTMLElement[] = [];
  for (const selector of selectors) {
    for (const raw of root.querySelectorAll(selector)) {
      const action = actionableElement(raw);
      if (!action || seen.has(action) || !elementVisible(action)) continue;
      if (excludeFooter && action.closest("#main footer")) continue;
      seen.add(action);
      actions.push(action);
    }
  }
  return actions;
}

function findMediaSendButtonNearPreview(previewElement: HTMLElement): SelectorMatch<HTMLElement> | null {
  for (const root of previewSearchRoots(previewElement)) {
    const registered = findMediaSendButton(root);
    if (registered && elementVisible(registered.element) && !registered.element.closest("#main footer")) {
      return registered as unknown as SelectorMatch<HTMLElement>;
    }
    const candidates = visibleUniqueActions(root, MEDIA_SEND_FALLBACK_SELECTORS);
    if (candidates.length === 1) {
      return {
        element: candidates[0],
        strategy: "media-send.semantic-preview-scope.2026",
        selector: MEDIA_SEND_FALLBACK_SELECTORS.join(", ")
      };
    }
  }
  return null;
}

function isDisabledAction(element: HTMLElement): boolean {
  return (element instanceof HTMLButtonElement && element.disabled)
    || element.getAttribute("aria-disabled") === "true"
    || element.getAttribute("data-disabled") === "true";
}

function normalizeActionText(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("es");
}

function findVisibleActionByText(labels: Set<string>, root: ParentNode = document): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>(
    "button, [role='button'], [role='menuitem'], [role='menuitemradio'], [role='radio'], [role='option']"
  );
  for (const candidate of candidates) {
    if (!elementVisible(candidate)) continue;
    const label = normalizeActionText(
      candidate.getAttribute("aria-label")
      || candidate.getAttribute("title")
      || candidate.textContent
    );
    if (labels.has(label)) return candidate;
  }
  return null;
}

function qualityStateEnabled(element: HTMLElement): boolean {
  return element.getAttribute("aria-pressed") === "true"
    || element.getAttribute("aria-checked") === "true"
    || ["active", "selected", "on"].includes(String(element.getAttribute("data-state") || "").toLowerCase());
}

async function preferHdQuality(previewElement: HTMLElement): Promise<MediaQualityResult> {
  let control: HTMLElement | null = null;
  for (const root of previewSearchRoots(previewElement)) {
    const candidates = visibleUniqueActions(root, HD_CONTROL_SELECTORS);
    if (candidates.length === 1) {
      control = candidates[0];
      break;
    }
  }
  if (!control) return "hd_unavailable";
  if (qualityStateEnabled(control)) return "hd_already_enabled";

  const directToggle = control.hasAttribute("aria-pressed") || control.hasAttribute("aria-checked");
  const popupToggle = control.hasAttribute("aria-haspopup");
  if (!directToggle && !popupToggle) return "hd_unavailable";

  control.click();
  if (directToggle) {
    const enabled = await waitForCondition(() => qualityStateEnabled(control!) ? true : null, {
      timeoutMs: 800,
      description: "la confirmación de calidad HD"
    }).catch(() => null);
    return enabled ? "hd_enabled" : "hd_not_confirmed";
  }

  const option = await waitForCondition(() => findVisibleActionByText(HD_OPTION_LABELS), {
    timeoutMs: 1_200,
    description: "la opción de calidad HD"
  }).catch(() => null);
  if (!option) {
    control.click();
    return "hd_not_confirmed";
  }
  option.click();

  const done = await waitForCondition(() => findVisibleActionByText(DONE_LABELS), {
    timeoutMs: 700,
    description: "la confirmación de calidad de imagen"
  }).catch(() => null);
  done?.click();
  return "hd_enabled";
}

export async function sendAndVerifyImage(
  input: ImageSendInput,
  lifecycle: { beforeSend?: (baselineOutgoingIds: string[]) => Promise<void> } = {}
): Promise<ImageSendResult> {
  const startedAt = new Date().toISOString();
  const imageLoadTimeoutMs = input.imageLoadTimeoutMs ?? 15_000;
  const previewTimeoutMs = input.previewTimeoutMs ?? 20_000;
  const confirmationTimeoutMs = input.confirmationTimeoutMs ?? 30_000;
  requireConversationContext(input.expectedPhoneDigits);
  const baselineOutgoingIds = outgoingMediaMessages().filter((item) => item.stableIdentity).map((item) => item.identity);
  const before = new Set(baselineOutgoingIds);

  const inputResolution = resolveCapability<HTMLInputElement>("image_file_input");
  const attachResolution = resolveCapability<HTMLButtonElement>("attachment_action", document, { required: true });
  const existingInput = inputResolution.match;
  const attach = attachResolution.match;
  if (attach) attach.element.click();
  if (!attach && !existingInput) {
    throw capabilityResolutionError(
      attachResolution.discovery,
      "Se agotaron las estrategias para localizar el mecanismo de adjuntos."
    );
  }

  const fileInput = existingInput ?? await waitForCondition(() => findImageFileInput(), {
    timeoutMs: imageLoadTimeoutMs,
    description: "el input de imágenes de WhatsApp"
  }).catch((error: unknown) => {
    throw capabilityResolutionError(
      resolveCapability("image_file_input", document, { required: true }).discovery,
      "Se agotaron las estrategias para localizar el input de imágenes.",
      error
    );
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
    throw capabilityResolutionError(
      resolveCapability("media_preview", document, { required: true }).discovery,
      "Se agotaron las estrategias para localizar el preview multimedia.",
      error
    );
  });

  const prepared = fileInput.element.files?.item(0);
  if (!prepared || prepared.name !== input.name || prepared.size !== input.size || prepared.type !== input.type) {
    throw new ExtensionError(ERROR_CODES.imageLoadFailed, "El preview no corresponde al archivo que debía enviarse.", {
      details: { imageId: input.imageId, sendAttempted: false }
    });
  }

  // La extensión entrega a WhatsApp exactamente el archivo local reconstruido;
  // no usa canvas, resize ni recodificación. Si WhatsApp ofrece un selector HD
  // accesible y verificable, se solicita antes de resolver el botón de envío.
  const qualityMode = await preferHdQuality(preview.element);
  const currentPreview = findMediaPreview()?.element ?? preview.element;

  const sendButton = await waitForCondition(
    () => findMediaSendButtonNearPreview(currentPreview),
    { timeoutMs: Math.min(previewTimeoutMs, 10_000), description: "la acción de enviar el preview multimedia" }
  ).catch((error: unknown) => {
    throw capabilityResolutionError(
      resolveCapability("media_send_action", currentPreview, { required: true }).discovery,
      "Se agotaron las estrategias para localizar la acción de envío multimedia.",
      error
    );
  });
  if (isDisabledAction(sendButton.element)) {
    throw capabilityUnavailableError(
      resolveCapability("media_send_action", currentPreview, { required: true }).discovery,
      "La acción de envío multimedia fue localizada, pero no está disponible."
    );
  }

  await lifecycle.beforeSend?.(baselineOutgoingIds);
  requireConversationContext(input.expectedPhoneDigits);
  sendButton.element.click();
  const verified = await waitForCondition(() => {
    requireConversationContext(input.expectedPhoneDigits);
    const outgoing = outgoingMediaMessages().find((item) => item.stableIdentity && !before.has(item.identity));
    return outgoing && !elementVisible(currentPreview) ? outgoing : null;
  }, {
    timeoutMs: confirmationTimeoutMs,
    description: "el nuevo mensaje multimedia saliente y el cierre de su preview"
  }).catch((error: unknown) => {
    const normalized = toExtensionError(error);
    if (normalized.code === ERROR_CODES.contactContextUnverified) throw normalized;
    throw new ExtensionError(ERROR_CODES.ambiguousResult, "Se accionó enviar, pero no se pudo confirmar el resultado multimedia.", {
      details: {
        imageId: input.imageId,
        sendAttempted: true,
        baselineOutgoingIds,
        previewSelector: preview.selector,
        qualityMode
      },
      cause: error
    });
  });
  requireConversationContext(input.expectedPhoneDigits);

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
        sendStrategy: sendButton.strategy,
        preparedName: input.name,
        preparedSize: input.size,
        preparedType: input.type,
        qualityMode,
        sourceBytesPreserved: prepared.size === input.size && prepared.type === input.type
      }
    }
  };
}
