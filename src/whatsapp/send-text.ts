import { ERROR_CODES, ExtensionError, toExtensionError } from "../shared/errors";
import { capabilityResolutionError, capabilityUnavailableError } from "../compatibility/diagnostic-error";
import { maskPhone } from "../shared/phone";
import type { TextTestResult } from "../shared/state";
import {
  canonicalMessageText,
  findComposer,
  findInvalidContactDialog,
  findSendButton,
  outgoingMessages,
  resolveCapability
} from "./selectors";
import { waitForCondition } from "./wait";
import { requireConversationContext } from "./conversation-context";

async function contactIdForPhone(phoneDigits: string): Promise<string> {
  const data = new TextEncoder().encode(`flor-mia-test-contact:${phoneDigits}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const id = [...new Uint8Array(digest)].slice(0, 10).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `contact-${id}`;
}

export function normalizeComposerLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function composerTextRepresentations(composer: HTMLElement): string[] {
  const values = [composer.innerText, composer.textContent]
    .filter((value): value is string => typeof value === "string")
    .map(normalizeComposerLineEndings);
  return [...new Set(values)];
}

function composerPlainText(composer: HTMLElement): string {
  const representations = composerTextRepresentations(composer);
  return representations[0] ?? "";
}

export type ComposerPreparationState = "empty" | "prepared" | "conflict";

export function classifyComposerContent(existingText: string, expectedText: string): ComposerPreparationState {
  const existing = normalizeComposerLineEndings(existingText);
  const expected = normalizeComposerLineEndings(expectedText);
  if (!canonicalMessageText(existing)) return "empty";
  return existing === expected ? "prepared" : "conflict";
}

function classifyComposerElementContent(composer: HTMLElement, expectedText: string): ComposerPreparationState {
  const expected = normalizeComposerLineEndings(expectedText);
  const representations = composerTextRepresentations(composer);
  if (representations.some((value) => value === expected)) return "prepared";
  if (representations.every((value) => !canonicalMessageText(value))) return "empty";
  return "conflict";
}

async function waitForPreparedComposer(expected: string, timeoutMs = 1_000): Promise<HTMLElement | null> {
  return waitForCondition(() => {
    const live = findComposer()?.element;
    if (!live) return null;
    return classifyComposerElementContent(live, expected) === "prepared" ? live : null;
  }, {
    timeoutMs,
    description: "que WhatsApp estabilice el texto preparado en el composer"
  }).catch(() => null);
}

export async function prepareComposerTextForSend(composer: HTMLElement, message: string): Promise<"inserted" | "reused"> {
  const expected = normalizeComposerLineEndings(message);
  const state = classifyComposerElementContent(composer, expected);
  if (state === "prepared") return "reused";
  if (state === "conflict") {
    throw new ExtensionError(
      ERROR_CODES.invalidInput,
      "La conversación tiene un borrador diferente. Vacialo manualmente antes de continuar para no sobrescribirlo.",
      { recoverable: true, details: { sendAttempted: false, draftConflict: true } }
    );
  }

  composer.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);

  const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, expected);
  let prepared = await waitForPreparedComposer(expected, inserted ? 800 : 50);

  if (!prepared) {
    const liveComposer = findComposer()?.element ?? composer;
    liveComposer.focus();
    liveComposer.replaceChildren(document.createTextNode(expected));
    const event = typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: expected })
      : new Event("input", { bubbles: true });
    liveComposer.dispatchEvent(event);
    prepared = await waitForPreparedComposer(expected, 1_000);
  }

  if (!prepared) {
    throw capabilityUnavailableError(
      resolveCapability("composer", document, { required: true }).discovery,
      "WhatsApp localizó el composer, pero no conservó exactamente el texto preparado por la campaña."
    );
  }
  return "inserted";
}

export function scheduleConversationNavigation(phoneDigits: string): void {
  const target = new URL("/send", "https://web.whatsapp.com");
  target.searchParams.set("phone", phoneDigits);
  target.searchParams.set("type", "phone_number");
  target.searchParams.set("app_absent", "0");
  window.setTimeout(() => window.location.assign(target.toString()), 0);
}

export async function sendAndVerifyText(input: {
  operationId: string;
  phoneDigits: string;
  message: string;
  timeoutMs?: number;
  checkpointRequired?: boolean;
}, lifecycle: { beforeSend?: (baselineOutgoingIds: string[]) => Promise<void> } = {}): Promise<TextTestResult> {
  const { operationId, phoneDigits, message, timeoutMs = 30_000 } = input;
  const startedAt = new Date().toISOString();
  requireConversationContext(phoneDigits);
  const invalidDialog = findInvalidContactDialog();
  if (invalidDialog) {
    throw new ExtensionError(ERROR_CODES.contactUnavailable, "WhatsApp informó que el número no es válido o no está disponible.", {
      details: { selectorStrategy: invalidDialog.strategy }
    });
  }

  const composerMatch = await waitForCondition(() => {
    const invalid = findInvalidContactDialog();
    if (invalid) throw new ExtensionError(ERROR_CODES.contactUnavailable, "El número no está disponible en WhatsApp.");
    return findComposer();
  }, { timeoutMs, description: "el campo de escritura de la conversación" }).catch((error: unknown) => {
    const normalized = toExtensionError(error);
    if (normalized.code === ERROR_CODES.contactUnavailable) throw normalized;
    throw capabilityResolutionError(
      resolveCapability("composer", document, { required: true }).discovery,
      "La capability del composer dejó de estar disponible.",
      error
    );
  });

  const beforeIds = new Set(outgoingMessages().filter((item) => item.stableIdentity).map((item) => item.identity));
  await prepareComposerTextForSend(composerMatch.element, message);
  const sendButton = await waitForCondition(() => findSendButton(), {
    timeoutMs: Math.min(timeoutMs, 10_000),
    description: "la acción de enviar texto"
  }).catch((error: unknown) => {
    throw capabilityResolutionError(
      resolveCapability("text_send_action", document, { required: true }).discovery,
      "Se agotaron las estrategias para localizar la acción de envío de texto.",
      error
    );
  });
  if (sendButton.element.disabled || sendButton.element.getAttribute("aria-disabled") === "true") {
    throw capabilityUnavailableError(
      resolveCapability("text_send_action", document, { required: true }).discovery,
      "La acción de envío de texto fue localizada, pero no está disponible."
    );
  }
  await lifecycle.beforeSend?.([...beforeIds]);
  requireConversationContext(phoneDigits);
  const liveComposer = findComposer()?.element;
  if (!liveComposer || classifyComposerElementContent(liveComposer, message) !== "prepared") {
    throw new ExtensionError(
      ERROR_CODES.verificationFailed,
      "El contenido del composer cambió antes del envío. Se canceló el click para evitar enviar texto incorrecto.",
      { recoverable: true, details: { sendAttempted: false, expectedLength: message.length } }
    );
  }
  sendButton.element.click();

  const expected = canonicalMessageText(message);
  const verified = await waitForCondition(() => {
    requireConversationContext(phoneDigits);
    return outgoingMessages().find((item) => item.stableIdentity && !beforeIds.has(item.identity) && item.text === expected) ?? null;
  }, { timeoutMs, description: "un nuevo mensaje saliente que coincida con el texto enviado" }).catch((error: unknown) => {
    const normalized = toExtensionError(error);
    if (normalized.code === ERROR_CODES.contactContextUnverified) throw normalized;
    throw new ExtensionError(ERROR_CODES.verificationFailed, "No se pudo confirmar un nuevo mensaje saliente en WhatsApp.", {
      details: { expectedLength: expected.length, sendAttempted: true, baselineOutgoingIds: [...beforeIds] },
      cause: error
    });
  });
  requireConversationContext(phoneDigits);

  return {
    success: true,
    operationId,
    contactId: await contactIdForPhone(phoneDigits),
    maskedPhone: maskPhone(`+${phoneDigits}`),
    step: "text",
    startedAt,
    completedAt: new Date().toISOString(),
    verification: {
      confirmed: true,
      method: "new-outgoing-message-dom",
      matchedTextLength: expected.length,
      messageElementId: verified.identity
    }
  };
}
