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

function setComposerText(composer: HTMLElement, message: string): void {
  const existing = canonicalMessageText(composer.textContent ?? "");
  if (existing) {
    throw new ExtensionError(
      ERROR_CODES.invalidInput,
      "La conversación tiene un borrador. Vacialo manualmente antes de ejecutar la prueba para no sobrescribirlo."
    );
  }
  composer.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);

  const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, message);
  if (!inserted || canonicalMessageText(composer.textContent ?? "") !== canonicalMessageText(message)) {
    composer.replaceChildren(document.createTextNode(message));
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
  }
  if (canonicalMessageText(composer.textContent ?? "") !== canonicalMessageText(message)) {
    throw capabilityUnavailableError(
      resolveCapability("composer", document, { required: true }).discovery,
      "WhatsApp localizó el composer, pero no reflejó el texto de forma funcional."
    );
  }
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
  setComposerText(composerMatch.element, message);
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
