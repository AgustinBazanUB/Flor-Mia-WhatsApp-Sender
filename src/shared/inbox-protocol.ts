import type {
  WhatsAppInboxChat,
  WhatsAppInboxConversation,
  WhatsAppInboxSendResult
} from "../whatsapp/inbox-adapter";

export const INBOX_INTERNAL_CHANNEL = "flor_mia_whatsapp_inbox_internal";
export const INBOX_INTERNAL_VERSION = 1;

export const INBOX_INTERNAL_TYPES = {
  getChats: "INBOX_GET_CHATS",
  getMessages: "INBOX_GET_MESSAGES",
  sendText: "INBOX_SEND_TEXT"
} as const;

export type InboxInternalType = (typeof INBOX_INTERNAL_TYPES)[keyof typeof INBOX_INTERNAL_TYPES];
export type InboxInternalSource = "web-app-inbox-bridge" | "inbox-service-worker";

export interface InboxRequestMap {
  INBOX_GET_CHATS: { limit?: number };
  INBOX_GET_MESSAGES: { chatId: string; limit?: number };
  INBOX_SEND_TEXT: { chatId: string; message: string };
}

export interface InboxResponseMap {
  INBOX_GET_CHATS: WhatsAppInboxChat[];
  INBOX_GET_MESSAGES: WhatsAppInboxConversation;
  INBOX_SEND_TEXT: WhatsAppInboxSendResult;
}

export interface InboxInternalEnvelope<T extends InboxInternalType = InboxInternalType> {
  channel: typeof INBOX_INTERNAL_CHANNEL;
  protocolVersion: typeof INBOX_INTERNAL_VERSION;
  type: T;
  requestId: string;
  source: InboxInternalSource;
  payload: InboxRequestMap[T];
}

export interface InboxInternalResponse<T> {
  ok: boolean;
  requestId: string;
  data?: T;
  error?: { code: string; message: string; recoverable: boolean; details?: Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validPayload(type: string, payload: Record<string, unknown>): boolean {
  if (type === INBOX_INTERNAL_TYPES.getChats) {
    return payload.limit === undefined || (Number.isInteger(payload.limit) && Number(payload.limit) >= 1 && Number(payload.limit) <= 100);
  }
  if (type === INBOX_INTERNAL_TYPES.getMessages) {
    return typeof payload.chatId === "string"
      && payload.chatId.length > 0
      && payload.chatId.length <= 200
      && (payload.limit === undefined || (Number.isInteger(payload.limit) && Number(payload.limit) >= 1 && Number(payload.limit) <= 100));
  }
  if (type === INBOX_INTERNAL_TYPES.sendText) {
    return typeof payload.chatId === "string"
      && payload.chatId.length > 0
      && payload.chatId.length <= 200
      && typeof payload.message === "string"
      && payload.message.trim().length > 0
      && payload.message.length <= 4_096;
  }
  return false;
}

export function isInboxInternalEnvelope(value: unknown): value is InboxInternalEnvelope {
  if (!isRecord(value) || !isRecord(value.payload)) return false;
  return value.channel === INBOX_INTERNAL_CHANNEL
    && value.protocolVersion === INBOX_INTERNAL_VERSION
    && Object.values(INBOX_INTERNAL_TYPES).includes(value.type as InboxInternalType)
    && typeof value.requestId === "string"
    && value.requestId.length > 0
    && value.requestId.length <= 200
    && (value.source === "web-app-inbox-bridge" || value.source === "inbox-service-worker")
    && validPayload(String(value.type), value.payload);
}

export function createInboxInternalEnvelope<T extends InboxInternalType>(
  source: InboxInternalSource,
  type: T,
  payload: InboxRequestMap[T],
  requestId = globalThis.crypto?.randomUUID?.() || `inbox-${Date.now()}-${Math.random().toString(36).slice(2)}`
): InboxInternalEnvelope<T> {
  return {
    channel: INBOX_INTERNAL_CHANNEL,
    protocolVersion: INBOX_INTERNAL_VERSION,
    type,
    requestId,
    source,
    payload
  };
}

export async function sendInboxRuntimeRequest<T extends InboxInternalType>(
  type: T,
  payload: InboxRequestMap[T],
  requestId?: string
): Promise<InboxResponseMap[T]> {
  const request = createInboxInternalEnvelope("web-app-inbox-bridge", type, payload, requestId);
  const response = await chrome.runtime.sendMessage(request) as InboxInternalResponse<InboxResponseMap[T]> | undefined;
  if (!response) throw new Error("La extensión no respondió al Inbox.");
  if (!response.ok || response.data === undefined) {
    const error = new Error(response.error?.message || "La operación de Inbox falló.");
    Object.assign(error, {
      code: response.error?.code || "INBOX_INTERNAL_ERROR",
      recoverable: response.error?.recoverable !== false,
      details: response.error?.details
    });
    throw error;
  }
  return response.data;
}
