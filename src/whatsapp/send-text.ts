import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { maskPhone } from "../shared/phone";
import type { TextTestResult } from "../shared/state";
import {
  canonicalMessageText,
  findComposer,
  findInvalidContactDialog,
  findSendButton,
  outgoingMessages
} from "./selectors";
import { waitForCondition } from "./wait";

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
    throw new ExtensionError(ERROR_CODES.elementNotFound, "WhatsApp no reflejó el texto dentro del campo de escritura.");
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
}): Promise<TextTestResult> {
  const { operationId, phoneDigits, message, timeoutMs = 30_000 } = input;
  const startedAt = new Date().toISOString();
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
  }, { timeoutMs, description: "el campo de escritura de la conversación" });

  const beforeIds = new Set(outgoingMessages().map((item) => item.identity));
  setComposerText(composerMatch.element, message);
  const sendButton = await waitForCondition(() => findSendButton(), {
    timeoutMs: Math.min(timeoutMs, 10_000),
    description: "la acción de enviar texto"
  });
  if (sendButton.element.disabled || sendButton.element.getAttribute("aria-disabled") === "true") {
    throw new ExtensionError(ERROR_CODES.elementNotFound, "El botón de envío está deshabilitado.");
  }
  sendButton.element.click();

  const expected = canonicalMessageText(message);
  const verified = await waitForCondition(() => {
    return outgoingMessages().find((item) => !beforeIds.has(item.identity) && item.text === expected) ?? null;
  }, { timeoutMs, description: "un nuevo mensaje saliente que coincida con el texto enviado" }).catch((error: unknown) => {
    throw new ExtensionError(ERROR_CODES.verificationFailed, "No se pudo confirmar un nuevo mensaje saliente en WhatsApp.", {
      details: { expectedLength: expected.length },
      cause: error
    });
  });

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
