import type { StepVerification } from "../engine/types";
import { ERROR_CODES, ExtensionError, toExtensionError } from "../shared/errors";
import { capabilityResolutionError, capabilityUnavailableError } from "../compatibility/diagnostic-error";
import {
  elementVisible,
  findComposer,
  findMediaPreview,
  findMediaSendButton,
  resolveCapability,
  type SelectorMatch
} from "./selectors";
import {
  outgoingPhotoMessages,
  startCausalOutgoingPhotoObserver,
  type CausalOutgoingPhotoObservation
} from "./photo-evidence";
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
const PHOTO_VIDEO_LABEL = /^(photos?\s*(?:&|and)\s*videos?|fotos?\s*(?:y|e)\s*v[ií]deos?|foto\s*(?:y|e)\s*video)$/i;
const STICKER_TERMS = /sticker|pegatina|figurinha|adhesivo/i;
const PHOTO_VIDEO_TERMS = /photo|photos|foto|fotos|image|imagen|imágenes|imagem|video|vídeo|videos|vídeos/i;

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
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate) {
      return {
        element: candidate,
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

function findPhotoVideoMenuAction(root: ParentNode = document): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>("[role='button'], [role='menuitem'], button, li[tabindex]");
  for (const candidate of candidates) {
    if (!elementVisible(candidate)) continue;
    const label = String(
      candidate.getAttribute("aria-label")
      || candidate.getAttribute("title")
      || candidate.textContent
      || ""
    ).replace(/\s+/g, " ").trim();
    if (PHOTO_VIDEO_LABEL.test(label)) return candidate;
  }
  return null;
}

function inputSemanticContext(input: HTMLInputElement): string {
  const values = [
    input.accept,
    input.name,
    input.id,
    input.getAttribute("aria-label") || "",
    input.getAttribute("title") || "",
    input.getAttribute("data-testid") || ""
  ];
  let current: HTMLElement | null = input.parentElement;
  for (let depth = 0; current && depth < 3; depth += 1, current = current.parentElement) {
    values.push(current.getAttribute("aria-label") || "");
    values.push(current.getAttribute("title") || "");
    values.push(current.getAttribute("data-testid") || "");
    values.push((current.textContent || "").slice(0, 120));
  }
  return values.join(" ").replace(/\s+/g, " ").trim();
}

function acceptsImage(input: HTMLInputElement): boolean {
  const accept = input.accept.toLowerCase();
  return accept.includes("image/") || /\.(?:png|jpe?g|gif|bmp|webp)\b/.test(accept);
}

function looksLikeStickerInput(input: HTMLInputElement): boolean {
  const context = inputSemanticContext(input);
  if (STICKER_TERMS.test(context)) return true;
  const accept = input.accept.toLowerCase().replace(/\s+/g, "");
  return accept !== "" && /image\/webp|\.webp/.test(accept)
    && !/image\/\*|image\/png|image\/jpe?g|video\//.test(accept);
}

function scorePhotoVideoInput(input: HTMLInputElement, preexisting: Set<HTMLInputElement>): number {
  if (input.type !== "file" || !acceptsImage(input) || looksLikeStickerInput(input)) return -1;
  const accept = input.accept.toLowerCase();
  const context = inputSemanticContext(input);
  let score = 0;
  if (/video\//.test(accept) || /video\/mp4|video\/3gpp|video\/quicktime/.test(accept)) score += 120;
  if (/image\/png|image\/jpe?g|\.png|\.jpe?g/.test(accept)) score += 45;
  if (!preexisting.has(input)) score += 70;
  if (PHOTO_VIDEO_TERMS.test(context)) score += 35;
  if (input.closest("#main")) score += 15;
  if (accept.trim() === "image/*") score += 5;
  return score;
}

function bestPhotoVideoInput(preexisting: Set<HTMLInputElement>, minimumScore = 70): SelectorMatch<HTMLInputElement> | null {
  const ranked = [...document.querySelectorAll<HTMLInputElement>("input[type='file']")]
    .map((element) => ({ element, score: scorePhotoVideoInput(element, preexisting) }))
    .filter((candidate) => candidate.score >= minimumScore)
    .sort((a, b) => b.score - a.score);
  const first = ranked[0];
  if (!first) return null;
  if (ranked[1]?.score === first.score) return null;
  return {
    element: first.element,
    strategy: `photo-input.semantic-score.${first.score}`,
    selector: `input[type='file'][accept='${first.element.accept.replace(/'/g, "\\'")}']`
  };
}

async function capturePhotoVideoInputFromMenuAction(
  action: HTMLElement,
  preexisting: Set<HTMLInputElement>
): Promise<SelectorMatch<HTMLInputElement> | null> {
  let intercepted: HTMLInputElement | null = null;
  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "file") return;
    if (!acceptsImage(target) || looksLikeStickerInput(target)) return;
    event.preventDefault();
    intercepted = target;
  };
  document.addEventListener("click", onClick, true);
  try {
    action.click();
    const resolved = await waitForCondition(() => {
      if (intercepted) {
        return {
          element: intercepted,
          strategy: "photo-input.photos-videos-action",
          selector: "Photos & videos → input[type='file']"
        } satisfies SelectorMatch<HTMLInputElement>;
      }
      return bestPhotoVideoInput(preexisting);
    }, {
      timeoutMs: 900,
      description: "el uploader de Fotos y videos de WhatsApp"
    }).catch(() => null);
    return resolved;
  } finally {
    document.removeEventListener("click", onClick, true);
  }
}

async function resolvePhotoVideoFileInput(
  attach: SelectorMatch<HTMLButtonElement> | null,
  timeoutMs: number
): Promise<SelectorMatch<HTMLInputElement>> {
  const preexisting = new Set(document.querySelectorAll<HTMLInputElement>("input[type='file']"));
  const initial = bestPhotoVideoInput(preexisting);
  if (!attach && initial) return initial;
  if (!attach) {
    throw new ExtensionError(ERROR_CODES.attachmentUnavailable, "No se encontró el uploader de Fotos y videos de WhatsApp.", {
      recoverable: false,
      details: { expectedMediaRoute: "photos_videos", sendAttempted: false }
    });
  }

  attach.element.click();
  const discovered = await waitForCondition(() => {
    const action = findPhotoVideoMenuAction();
    return action || bestPhotoVideoInput(preexisting);
  }, {
    timeoutMs: Math.min(timeoutMs, 2_500),
    description: "la opción Fotos y videos de WhatsApp"
  }).catch(() => null);

  if (discovered instanceof HTMLElement && !(discovered instanceof HTMLInputElement)) {
    const throughAction = await capturePhotoVideoInputFromMenuAction(discovered, preexisting);
    if (throughAction) return throughAction;
  } else if (discovered && "element" in discovered) {
    return discovered;
  }

  const fallback = await waitForCondition(() => bestPhotoVideoInput(preexisting), {
    timeoutMs: Math.min(timeoutMs, 1_500),
    description: "el input específico de Fotos y videos"
  }).catch(() => null);
  if (fallback) return fallback;

  throw new ExtensionError(ERROR_CODES.attachmentUnavailable, "WhatsApp no expuso un uploader verificable de Fotos y videos. No se usará un input genérico porque podría enviar la imagen como sticker.", {
    recoverable: false,
    details: {
      expectedMediaRoute: "photos_videos",
      availableFileInputs: document.querySelectorAll("input[type='file']").length,
      sendAttempted: false
    }
  });
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
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate) {
      control = candidate;
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

function composerReady(): boolean {
  const composer = findComposer()?.element;
  return Boolean(composer && elementVisible(composer));
}

export async function sendAndVerifyImage(
  input: ImageSendInput,
  lifecycle: { beforeSend?: (baselineOutgoingIds: string[]) => Promise<void> } = {}
): Promise<ImageSendResult> {
  const startedAt = new Date().toISOString();
  const imageLoadTimeoutMs = input.imageLoadTimeoutMs ?? 15_000;
  const previewTimeoutMs = input.previewTimeoutMs ?? 20_000;
  const confirmationTimeoutMs = input.confirmationTimeoutMs ?? 8_000;
  requireConversationContext(input.expectedPhoneDigits);
  const baselineOutgoingIds = outgoingPhotoMessages().filter((item) => item.stableIdentity).map((item) => item.identity);
  const before = new Set(baselineOutgoingIds);

  const attachResolution = resolveCapability<HTMLButtonElement>("attachment_action", document, { required: true });
  const attach = attachResolution.match;
  const fileInput = await resolvePhotoVideoFileInput(attach, imageLoadTimeoutMs).catch((error: unknown) => {
    if (error instanceof ExtensionError) throw error;
    throw capabilityResolutionError(
      attachResolution.discovery,
      "Se agotaron las estrategias para localizar Fotos y videos.",
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
  const main = document.getElementById("main");
  if (!(main instanceof HTMLElement)) {
    throw new ExtensionError(ERROR_CODES.interfaceLoading, "No se encontró el chat activo para observar el resultado del envío.", {
      recoverable: true,
      details: { imageId: input.imageId, sendAttempted: false }
    });
  }

  const causalObserver = startCausalOutgoingPhotoObserver(main);
  let verified: CausalOutgoingPhotoObservation | null = null;
  try {
    sendButton.element.click();
    verified = await waitForCondition(() => {
      requireConversationContext(input.expectedPhoneDigits);
      if (elementVisible(currentPreview)) return null;

      const stable = outgoingPhotoMessages().find((item) => item.stableIdentity && !before.has(item.identity));
      if (stable) {
        return {
          snapshot: stable,
          method: "stable-outgoing-photo-dom",
          observedAt: new Date().toISOString()
        } satisfies CausalOutgoingPhotoObservation;
      }

      const causal = causalObserver.take();
      return causal && composerReady() ? causal : null;
    }, {
      timeoutMs: confirmationTimeoutMs,
      description: "la evidencia causal de la foto saliente"
    });
  } catch (error: unknown) {
    const normalized = toExtensionError(error);
    if (normalized.code === ERROR_CODES.contactContextUnverified) throw normalized;
    const observerSummary = causalObserver.summary();
    const previewDismissed = !elementVisible(currentPreview);
    const composerRestored = composerReady();
    const currentPhotoCount = outgoingPhotoMessages().length;
    throw new ExtensionError(
      ERROR_CODES.ambiguousResult,
      "Se hizo clic en Enviar, pero WhatsApp no expuso evidencia técnica suficiente para confirmar la foto. La campaña se pausa para evitar duplicarla.",
      {
        details: {
          imageId: input.imageId,
          sendAttempted: true,
          baselineOutgoingIds,
          previewSelector: preview.selector,
          qualityMode,
          uploadStrategy: fileInput.strategy,
          expectedOutgoingKind: "photo",
          confirmationTimeoutMs,
          previewDismissed,
          composerRestored,
          currentPhotoCount,
          causalNewOutgoingBubbleCount: observerSummary.newOutgoingBubbleCount,
          causalPhotoObserved: observerSummary.photoObserved,
          causalStableIdObserved: observerSummary.stableIdObserved,
          causalEvidenceMethod: observerSummary.evidenceMethod
        },
        cause: error
      }
    );
  } finally {
    causalObserver.stop();
  }

  requireConversationContext(input.expectedPhoneDigits);
  const usedCausalFallback = verified.method === "causal-outgoing-photo-mutation";
  const verificationMethod = usedCausalFallback
    ? "causal-outgoing-photo-mutation+preview-dismissed+composer-ready"
    : "new-outgoing-photo-dom+preview-dismissed";

  return {
    success: true,
    operationId: input.operationId,
    imageId: input.imageId,
    startedAt,
    completedAt: new Date().toISOString(),
    verification: {
      outcome: "confirmed",
      confidence: usedCausalFallback ? "causal" : "strong",
      method: verificationMethod,
      observedAt: verified.observedAt,
      sendAttempted: true,
      ...(verified.snapshot.stableIdentity ? { outgoingMessageId: verified.snapshot.identity } : {}),
      baselineOutgoingIds,
      details: {
        inputSelector: fileInput.selector,
        uploadStrategy: fileInput.strategy,
        expectedOutgoingKind: "photo",
        previewSelector: preview.selector,
        sendSelector: sendButton.selector,
        sendStrategy: sendButton.strategy,
        preparedName: input.name,
        preparedSize: input.size,
        preparedType: input.type,
        qualityMode,
        sourceBytesPreserved: prepared.size === input.size && prepared.type === input.type,
        photoEvidenceMethod: verified.method,
        stablePhotoIdentity: verified.snapshot.stableIdentity,
        previewDismissed: true,
        composerRestored: usedCausalFallback ? true : composerReady()
      }
    }
  };
}
