import { ERROR_CODES, ExtensionError } from "../shared/errors";
import {
  canonicalMessageText,
  findComposer,
  findConversationHeader,
  findMainInterface,
  findQrCode,
  findSendButton,
  outgoingMessages
} from "./selectors";
import { prepareComposerTextForSend } from "./send-text";
import { waitForCondition } from "./wait";

export interface WhatsAppInboxChat {
  chatId: string;
  name: string;
  phone: string | null;
  lastMessage: string;
  timestampLabel: string;
  unreadCount: number;
  labels: string[];
}

export interface WhatsAppInboxMessage {
  messageId: string;
  direction: "incoming" | "outgoing";
  text: string;
  timestampLabel: string;
}

export interface WhatsAppInboxConversation {
  chat: WhatsAppInboxChat;
  messages: WhatsAppInboxMessage[];
  hasMore: boolean;
}

export interface WhatsAppInboxSendResult {
  chatId: string;
  sent: true;
  verified: boolean;
  sentAt: string;
}

const CHAT_ROW_SELECTORS = [
  "#pane-side [data-testid='cell-frame-container']",
  "#pane-side [role='row']",
  "#pane-side [role='listitem']"
] as const;

const MESSAGE_SELECTORS = [
  "#main .message-in",
  "#main .message-out",
  "#main [data-id^='true_']",
  "#main [data-id^='false_']",
  "#main [data-testid='msg-container']"
] as const;

function compactText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function phoneCandidate(value: string): string | null {
  const clean = compactText(value);
  if (!clean || !/[+\d]/.test(clean)) return null;
  const digits = clean.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  // Evita interpretar horas/fechas o previews con números como teléfonos.
  if (!/^\+?[\d\s().-]+$/.test(clean)) return null;
  return clean;
}

function elementTextCandidates(root: HTMLElement): string[] {
  const values = [...root.querySelectorAll<HTMLElement>("span[title], [title], span")]
    .map((element) => compactText(element.getAttribute("title") || element.textContent))
    .filter(Boolean);
  return [...new Set(values)];
}

function rowDataIdentity(row: HTMLElement): string {
  const own = compactText(row.getAttribute("data-id"));
  if (own) return own;
  const descendant = row.querySelector<HTMLElement>("[data-id*='@'], [data-id^='true_'], [data-id^='false_']");
  return compactText(descendant?.getAttribute("data-id"));
}

function unreadCount(row: HTMLElement): number {
  const candidate = row.querySelector<HTMLElement>(
    "[data-testid*='unread' i], [aria-label*='unread' i], [aria-label*='no leído' i], [aria-label*='no leídos' i], [aria-label*='sin leer' i]"
  );
  if (!candidate) return 0;
  const text = `${candidate.getAttribute("aria-label") || ""} ${candidate.textContent || ""}`;
  const number = text.match(/\d+/)?.[0];
  return number ? Math.max(1, Number(number)) : 1;
}

function timestampCandidate(values: string[]): string {
  return values.find((value) => /^(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[ap]\.?(?:m\.)?)?$/i.test(value))
    || values.find((value) => /^(hoy|ayer|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)$/i.test(value))
    || "";
}

function nameCandidate(row: HTMLElement, values: string[]): string {
  const titled = [...row.querySelectorAll<HTMLElement>("span[title], [title]")]
    .map((element) => compactText(element.getAttribute("title")))
    .find((value) => value && !timestampCandidate([value]));
  return titled || values.find((value) => !timestampCandidate([value])) || "Contacto de WhatsApp";
}

function chatRowElements(): HTMLElement[] {
  const found: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const selector of CHAT_ROW_SELECTORS) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (seen.has(element)) continue;
      seen.add(element);
      found.push(element);
    }
    if (found.length) break;
  }
  return found;
}

function chatFromRow(row: HTMLElement, index: number): WhatsAppInboxChat {
  const values = elementTextCandidates(row);
  const timestampLabel = timestampCandidate(values);
  const name = nameCandidate(row, values);
  const phone = [name, ...values].map(phoneCandidate).find(Boolean) || null;
  const unread = unreadCount(row);
  const lastMessage = [...values]
    .reverse()
    .find((value) => value !== name && value !== timestampLabel && value !== String(unread) && !phoneCandidate(value)) || "";
  const dataIdentity = rowDataIdentity(row);
  const fingerprint = dataIdentity || `${name}|${phone || ""}|${lastMessage}|${timestampLabel}|${index}`;
  return {
    chatId: `wa-chat-${stableHash(fingerprint)}`,
    name,
    phone,
    lastMessage,
    timestampLabel,
    unreadCount: unread,
    // WhatsApp Business labels are not exposed consistently in the chat-list DOM.
    // Keep the contract ready without inventing labels that cannot be proven.
    labels: []
  };
}

function assertSessionReady(): void {
  if (findQrCode()) {
    throw new ExtensionError(ERROR_CODES.sessionNotReady, "WhatsApp Web necesita iniciar sesión antes de abrir la bandeja.");
  }
  if (!findMainInterface()) {
    throw new ExtensionError(ERROR_CODES.interfaceLoading, "La lista de chats de WhatsApp todavía no está disponible.");
  }
}

export function getInboxChats(limit = 80): WhatsAppInboxChat[] {
  assertSessionReady();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 80));
  return chatRowElements().slice(0, safeLimit).map(chatFromRow);
}

function findRowByChatId(chatId: string): { row: HTMLElement; chat: WhatsAppInboxChat } | null {
  const rows = chatRowElements();
  for (let index = 0; index < rows.length; index += 1) {
    const chat = chatFromRow(rows[index], index);
    if (chat.chatId === chatId) return { row: rows[index], chat };
  }
  return null;
}

function activeHeaderMetadata(fallback: WhatsAppInboxChat): WhatsAppInboxChat {
  const header = findConversationHeader()?.element;
  if (!header) return fallback;
  const values = elementTextCandidates(header);
  const name = nameCandidate(header, values) || fallback.name;
  const phone = [name, ...values].map(phoneCandidate).find(Boolean) || fallback.phone;
  return { ...fallback, name, phone };
}

async function openInboxChat(chatId: string, timeoutMs = 8_000): Promise<WhatsAppInboxChat> {
  assertSessionReady();
  const located = findRowByChatId(chatId);
  if (!located) {
    throw new ExtensionError(ERROR_CODES.contactUnavailable, "La conversación ya no está visible en la lista de chats.", {
      details: { inboxReason: "CHAT_NOT_FOUND" }
    });
  }
  located.row.click();
  await waitForCondition(() => {
    const main = document.getElementById("main");
    const header = findConversationHeader();
    return main && header ? header : null;
  }, { timeoutMs, description: "que WhatsApp abra la conversación seleccionada" }).catch((error: unknown) => {
    throw new ExtensionError(ERROR_CODES.timeout, "WhatsApp no terminó de abrir la conversación seleccionada.", {
      cause: error,
      details: { inboxReason: "CHAT_NOT_FOUND" }
    });
  });
  return activeHeaderMetadata(located.chat);
}

function messageTimestamp(element: HTMLElement): string {
  const prePlain = element.closest<HTMLElement>("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text")
    || element.querySelector<HTMLElement>("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text")
    || "";
  if (prePlain) return compactText(prePlain.replace(/:\s*$/, ""));
  const meta = element.querySelector<HTMLElement>("[data-testid='msg-meta'], .copyable-text [data-testid*='meta' i]");
  return compactText(meta?.textContent);
}

function messageElements(): HTMLElement[] {
  const root = document.getElementById("main");
  if (!root) return [];
  const candidates: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const selector of MESSAGE_SELECTORS) {
    for (const raw of root.querySelectorAll<HTMLElement>(selector.replace(/^#main\s*/, ""))) {
      const bubble = raw.closest<HTMLElement>(".message-in, .message-out, [data-id^='true_'], [data-id^='false_']") || raw;
      if (seen.has(bubble)) continue;
      seen.add(bubble);
      candidates.push(bubble);
    }
  }
  return candidates;
}

function messageFromElement(element: HTMLElement, index: number): WhatsAppInboxMessage | null {
  const dataId = compactText(element.getAttribute("data-id") || element.closest<HTMLElement>("[data-id]")?.getAttribute("data-id"));
  const direction: "incoming" | "outgoing" = element.classList.contains("message-out") || dataId.startsWith("true_")
    ? "outgoing"
    : "incoming";
  const textElement = element.querySelector<HTMLElement>("[data-testid='msg-text'], .selectable-text") || element;
  const text = canonicalMessageText(textElement.textContent || "").trim();
  if (!text) return null;
  const timestampLabel = messageTimestamp(element);
  return {
    messageId: dataId || `wa-message-${stableHash(`${direction}|${text}|${timestampLabel}|${index}`)}`,
    direction,
    text,
    timestampLabel
  };
}

export async function getInboxMessages(chatId: string, limit = 50): Promise<WhatsAppInboxConversation> {
  if (!chatId || chatId.length > 200) throw new ExtensionError(ERROR_CODES.invalidInput, "La conversación solicitada no es válida.");
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const chat = await openInboxChat(chatId);
  const all = messageElements().map(messageFromElement).filter((message): message is WhatsAppInboxMessage => Boolean(message));
  return {
    chat: { ...chat, unreadCount: 0 },
    messages: all.slice(-safeLimit),
    hasMore: all.length > safeLimit
  };
}

export async function sendInboxText(chatId: string, message: string): Promise<WhatsAppInboxSendResult> {
  const text = String(message || "").trim();
  if (!chatId || chatId.length > 200) throw new ExtensionError(ERROR_CODES.invalidInput, "La conversación solicitada no es válida.");
  if (!text) throw new ExtensionError(ERROR_CODES.invalidInput, "Escribí un mensaje antes de enviar.");
  if (text.length > 4_096) throw new ExtensionError(ERROR_CODES.invalidInput, "El mensaje supera 4.096 caracteres.");

  await openInboxChat(chatId);
  const composer = await waitForCondition(() => findComposer(), {
    timeoutMs: 8_000,
    description: "el campo para responder la conversación"
  }).catch((error: unknown) => {
    throw new ExtensionError(ERROR_CODES.elementNotFound, "No se encontró el campo para responder en WhatsApp.", { cause: error });
  });

  await prepareComposerTextForSend(composer.element, text);
  const button = await waitForCondition(() => findSendButton(), {
    timeoutMs: 5_000,
    description: "el botón para enviar la respuesta"
  }).catch((error: unknown) => {
    throw new ExtensionError(ERROR_CODES.elementNotFound, "No se encontró la acción de envío de WhatsApp.", { cause: error });
  });
  if (button.element.disabled || button.element.getAttribute("aria-disabled") === "true") {
    throw new ExtensionError(ERROR_CODES.elementNotFound, "WhatsApp todavía no habilitó el envío de esta respuesta.");
  }

  const root = document.getElementById("main") || document.body;
  const expected = canonicalMessageText(text);
  const baselineExact = outgoingMessages(root).filter((item) => item.text === expected).length;
  button.element.click();
  const sentAt = new Date().toISOString();

  const verified = await waitForCondition(() => {
    const exact = outgoingMessages(root).filter((item) => item.text === expected).length;
    return exact > baselineExact ? true : null;
  }, { timeoutMs: 6_000, description: "la confirmación visual del mensaje enviado" }).then(() => true).catch(() => false);

  if (!verified) {
    const liveComposer = findComposer()?.element;
    if (liveComposer && canonicalMessageText(liveComposer.textContent || liveComposer.innerText || "").trim()) {
      throw new ExtensionError(ERROR_CODES.verificationFailed, "WhatsApp no confirmó el envío de la respuesta.", {
        details: { sendAttempted: true, inboxReason: "SEND_FAILED" }
      });
    }
  }

  return { chatId, sent: true, verified, sentAt };
}
