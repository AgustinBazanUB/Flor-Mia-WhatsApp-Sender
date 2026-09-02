import { ERROR_CODES, ExtensionError, toExtensionError } from "../shared/errors";
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

export type WhatsAppInboxChatType = "individual" | "group" | "channel" | "community" | "other";
export type WhatsAppInboxIdentityConfidence = "structured" | "phone" | "name";

export interface WhatsAppInboxChat {
  chatId: string;
  name: string;
  phone: string | null;
  chatType: WhatsAppInboxChatType;
  identityConfidence: WhatsAppInboxIdentityConfidence;
  lastMessage: string;
  timestampLabel: string;
  unreadCount: number;
  unreadDisplay: string;
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
  verified: true;
  sentAt: string;
}

const CHAT_ROW_SELECTORS = [
  "#pane-side [data-testid='cell-frame-container']",
  "#pane-side [role='row']",
  "#pane-side [role='listitem']"
] as const;

const MESSAGE_SELECTORS = [
  ".message-in",
  ".message-out",
  "[data-id^='true_']",
  "[data-id^='false_']",
  "[data-testid='msg-container']"
] as const;

const STRUCTURED_CHAT_ATTRIBUTES = ["data-jid", "data-chat-id", "data-peer-id", "data-contact-id", "data-id"] as const;

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
  if (!/^\+?[\d\s().-]+$/.test(clean)) return null;
  return clean;
}

function elementTextCandidates(root: HTMLElement): string[] {
  const values = [...root.querySelectorAll<HTMLElement>("span[title], [title], span")]
    .map((element) => compactText(element.getAttribute("title") || element.textContent))
    .filter(Boolean);
  return [...new Set(values)];
}

function structuredChatIdentity(row: HTMLElement): string {
  const candidates = [row, ...row.querySelectorAll<HTMLElement>("[data-jid],[data-chat-id],[data-peer-id],[data-contact-id],[data-id]")];
  for (const element of candidates.slice(0, 50)) {
    for (const attribute of STRUCTURED_CHAT_ATTRIBUTES) {
      const value = compactText(element.getAttribute(attribute));
      if (value && (value.includes("@") || attribute !== "data-id")) return value;
    }
  }
  return "";
}

function chatTypeFromIdentity(identity: string): WhatsAppInboxChatType {
  if (/@g\.us\b/i.test(identity)) return "group";
  if (/@newsletter\b/i.test(identity)) return "channel";
  if (/community/i.test(identity)) return "community";
  if (/@(?:c\.us|s\.whatsapp\.net|lid)\b/i.test(identity)) return "individual";
  return "other";
}

function phoneFromIdentity(identity: string): string | null {
  const match = identity.match(/(?:^|_)(\d{8,15})@(?:c\.us|s\.whatsapp\.net)(?:\b|_)/i)
    ?? identity.match(/^(\d{8,15})@(?:c\.us|s\.whatsapp\.net)$/i);
  return match?.[1] ?? null;
}

function unreadMetadata(row: HTMLElement): { count: number; display: string } {
  const candidate = row.querySelector<HTMLElement>(
    "[data-testid*='unread' i], [aria-label*='unread' i], [aria-label*='no leído' i], [aria-label*='no leídos' i], [aria-label*='sin leer' i]"
  );
  if (!candidate) return { count: 0, display: "" };
  const text = compactText(`${candidate.getAttribute("aria-label") || ""} ${candidate.textContent || ""}`);
  const plus = text.match(/(\d+)\s*\+/);
  if (plus?.[1]) return { count: Math.max(1, Number(plus[1])), display: `${plus[1]}+` };
  const exact = text.match(/\d+/)?.[0];
  if (exact) return { count: Math.max(1, Number(exact)), display: exact };
  return { count: 1, display: "1" };
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

function chatFromRow(row: HTMLElement): WhatsAppInboxChat {
  const values = elementTextCandidates(row);
  const timestampLabel = timestampCandidate(values);
  const name = nameCandidate(row, values);
  const structuredIdentity = structuredChatIdentity(row);
  const structuredPhone = phoneFromIdentity(structuredIdentity);
  const phone = structuredPhone || [name, ...values].map(phoneCandidate).find(Boolean) || null;
  const unread = unreadMetadata(row);
  const lastMessage = [...values]
    .reverse()
    .find((value) => value !== name && value !== timestampLabel && value !== unread.display && !phoneCandidate(value)) || "";
  const identitySeed = structuredIdentity || (phone ? `phone:${phone.replace(/\D/g, "")}` : `name:${name.toLocaleLowerCase("es")}`);
  const identityConfidence: WhatsAppInboxIdentityConfidence = structuredIdentity ? "structured" : phone ? "phone" : "name";
  const inferredType = chatTypeFromIdentity(structuredIdentity);
  const chatType = inferredType === "other" && phone ? "individual" : inferredType;
  return {
    chatId: `wa-chat-${stableHash(identitySeed)}`,
    name,
    phone: chatType === "individual" ? phone : null,
    chatType,
    identityConfidence,
    lastMessage,
    timestampLabel,
    unreadCount: unread.count,
    unreadDisplay: unread.display,
    labels: []
  };
}

function assertSessionReady(): void {
  if (findQrCode()) throw new ExtensionError(ERROR_CODES.sessionNotReady, "WhatsApp Web necesita iniciar sesión antes de abrir la bandeja.");
  if (!findMainInterface()) throw new ExtensionError(ERROR_CODES.interfaceLoading, "La lista de chats de WhatsApp todavía no está disponible.");
}

export function getInboxChats(limit = 80): WhatsAppInboxChat[] {
  assertSessionReady();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 80));
  return chatRowElements().slice(0, safeLimit).map((row) => chatFromRow(row));
}

function findRowByChatId(chatId: string): { row: HTMLElement; chat: WhatsAppInboxChat } | null {
  const rows = chatRowElements();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    const chat = chatFromRow(row);
    if (chat.chatId === chatId) return { row, chat };
  }
  return null;
}

function activeHeaderMetadata(fallback: WhatsAppInboxChat): WhatsAppInboxChat {
  const header = findConversationHeader()?.element;
  if (!header) return fallback;
  const values = elementTextCandidates(header);
  const name = nameCandidate(header, values) || fallback.name;
  const phone = fallback.chatType === "individual"
    ? ([name, ...values].map(phoneCandidate).find(Boolean) || fallback.phone)
    : null;
  return { ...fallback, name, phone };
}

async function openInboxChat(chatId: string, timeoutMs = 8_000): Promise<WhatsAppInboxChat> {
  assertSessionReady();
  const located = findRowByChatId(chatId);
  if (!located) throw new ExtensionError(ERROR_CODES.contactUnavailable, "La conversación ya no está visible en la lista de chats.", { details: { inboxReason: "CHAT_NOT_FOUND" } });
  located.row.click();
  await waitForCondition(() => {
    const main = document.getElementById("main");
    const header = findConversationHeader();
    return main && header ? header : null;
  }, { timeoutMs, description: "que WhatsApp abra la conversación seleccionada" }).catch((error: unknown) => {
    throw new ExtensionError(ERROR_CODES.timeout, "WhatsApp no terminó de abrir la conversación seleccionada.", { cause: error, details: { inboxReason: "CHAT_NOT_FOUND" } });
  });
  const refreshed = findRowByChatId(chatId)?.chat ?? located.chat;
  return activeHeaderMetadata(refreshed);
}

function messageTimestamp(element: HTMLElement): string {
  const prePlain = element.closest<HTMLElement>("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text")
    || element.querySelector<HTMLElement>("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text") || "";
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
    for (const raw of root.querySelectorAll<HTMLElement>(selector)) {
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
  const direction: "incoming" | "outgoing" = element.classList.contains("message-out") || dataId.startsWith("true_") ? "outgoing" : "incoming";
  const textElement = element.querySelector<HTMLElement>("[data-testid='msg-text'], .selectable-text") || element;
  const text = canonicalMessageText(textElement.textContent || "").trim();
  if (!text) return null;
  const timestampLabel = messageTimestamp(element);
  return { messageId: dataId || `wa-message-${stableHash(`${direction}|${text}|${timestampLabel}|${index}`)}`, direction, text, timestampLabel };
}

export async function getInboxMessages(chatId: string, limit = 50): Promise<WhatsAppInboxConversation> {
  if (!chatId || chatId.length > 200) throw new ExtensionError(ERROR_CODES.invalidInput, "La conversación solicitada no es válida.");
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const chat = await openInboxChat(chatId);
  const all = messageElements().map(messageFromElement).filter((message): message is WhatsAppInboxMessage => Boolean(message));
  return { chat, messages: all.slice(-safeLimit), hasMore: all.length > safeLimit };
}

export async function sendInboxText(chatId: string, message: string): Promise<WhatsAppInboxSendResult> {
  const text = String(message || "").trim();
  if (!chatId || chatId.length > 200) throw new ExtensionError(ERROR_CODES.invalidInput, "La conversación solicitada no es válida.");
  if (!text) throw new ExtensionError(ERROR_CODES.invalidInput, "Escribí un mensaje antes de enviar.");
  if (text.length > 4_096) throw new ExtensionError(ERROR_CODES.invalidInput, "El mensaje supera 4.096 caracteres.");

  const chat = await openInboxChat(chatId);
  if (chat.chatId !== chatId) throw new ExtensionError(ERROR_CODES.contactContextUnverified, "WhatsApp cambió la conversación antes del envío.", { details: { inboxReason: "CHAT_CHANGED" } });
  if (chat.chatType !== "individual") throw new ExtensionError(ERROR_CODES.invalidInput, "Esta primera versión sólo permite responder chats individuales desde el Inbox.", { details: { inboxReason: "UNSUPPORTED_CHAT_TYPE", chatType: chat.chatType } });

  const composer = await waitForCondition(() => findComposer(), { timeoutMs: 8_000, description: "el campo para responder la conversación" }).catch((error: unknown) => {
    throw new ExtensionError(ERROR_CODES.elementNotFound, "No se encontró el campo para responder en WhatsApp.", { cause: error });
  });
  try {
    await prepareComposerTextForSend(composer.element, text);
  } catch (error) {
    const normalized = toExtensionError(error);
    if (normalized.details?.draftConflict === true) {
      throw new ExtensionError(ERROR_CODES.invalidInput, normalized.message, { recoverable: true, cause: error, details: { ...normalized.details, inboxReason: "COMPOSER_HAS_DRAFT" } });
    }
    throw error;
  }
  const button = await waitForCondition(() => findSendButton(), { timeoutMs: 5_000, description: "el botón para enviar la respuesta" }).catch((error: unknown) => {
    throw new ExtensionError(ERROR_CODES.elementNotFound, "No se encontró la acción de envío de WhatsApp.", { cause: error });
  });
  if (button.element.disabled || button.element.getAttribute("aria-disabled") === "true") throw new ExtensionError(ERROR_CODES.elementNotFound, "WhatsApp todavía no habilitó el envío de esta respuesta.");

  const root = document.getElementById("main") || document.body;
  const expected = canonicalMessageText(text);
  const baselineExact = outgoingMessages(root).filter((item) => item.text === expected).length;
  button.element.click();
  const sentAt = new Date().toISOString();
  const verified = await waitForCondition(() => {
    const stillSameChat = findRowByChatId(chatId) !== null;
    if (!stillSameChat) return null;
    const exact = outgoingMessages(root).filter((item) => item.text === expected).length;
    return exact > baselineExact ? true : null;
  }, { timeoutMs: 6_000, description: "la confirmación visual del mensaje enviado" }).then(() => true).catch(() => false);

  if (!verified) {
    throw new ExtensionError(ERROR_CODES.ambiguousResult, "WhatsApp recibió la acción de envío, pero no fue posible confirmar el resultado. No se reenviará automáticamente.", {
      recoverable: true,
      details: { sendAttempted: true, inboxReason: "SEND_STATUS_UNKNOWN" }
    });
  }
  return { chatId, sent: true, verified: true, sentAt };
}
