import { isAllowedWebAppOrigin } from "../config/origins";
import { INBOX_INTERNAL_TYPES, sendInboxRuntimeRequest } from "../shared/inbox-protocol";

const WEB_INBOX_CHANNEL = "flor_mia_whatsapp_inbox_extension";
const WEB_INBOX_VERSION = 1;

const WEB_INBOX_TYPES = {
  getChatsRequest: "FLORMIA_INBOX_GET_CHATS_REQUEST",
  chats: "FLORMIA_INBOX_CHATS",
  getMessagesRequest: "FLORMIA_INBOX_GET_MESSAGES_REQUEST",
  messages: "FLORMIA_INBOX_MESSAGES",
  sendTextRequest: "FLORMIA_INBOX_SEND_TEXT_REQUEST",
  textSent: "FLORMIA_INBOX_TEXT_SENT",
  error: "FLORMIA_INBOX_ERROR"
} as const;

type InboxWebRequestType = typeof WEB_INBOX_TYPES.getChatsRequest
  | typeof WEB_INBOX_TYPES.getMessagesRequest
  | typeof WEB_INBOX_TYPES.sendTextRequest;

interface InboxWebEnvelope {
  channel: typeof WEB_INBOX_CHANNEL;
  protocolVersion: typeof WEB_INBOX_VERSION;
  type: string;
  requestId?: string;
  replyTo?: string;
  payload: Record<string, unknown>;
}

interface InboxBridgeGuard {
  dispose: () => void;
}

type InboxBridgeGlobal = typeof globalThis & {
  __florMiaWhatsAppInboxBridgeV1?: InboxBridgeGuard;
};

const bridgeGlobal = globalThis as InboxBridgeGlobal;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validRequestPayload(type: InboxWebRequestType, payload: Record<string, unknown>): boolean {
  if (type === WEB_INBOX_TYPES.getChatsRequest) {
    return payload.limit === undefined || (Number.isInteger(payload.limit) && Number(payload.limit) >= 1 && Number(payload.limit) <= 100);
  }
  if (type === WEB_INBOX_TYPES.getMessagesRequest) {
    return typeof payload.chatId === "string"
      && payload.chatId.length > 0
      && payload.chatId.length <= 200
      && (payload.limit === undefined || (Number.isInteger(payload.limit) && Number(payload.limit) >= 1 && Number(payload.limit) <= 100));
  }
  return typeof payload.chatId === "string"
    && payload.chatId.length > 0
    && payload.chatId.length <= 200
    && typeof payload.message === "string"
    && payload.message.trim().length > 0
    && payload.message.length <= 4_096;
}

function parseRequest(value: unknown): InboxWebEnvelope & { type: InboxWebRequestType; requestId: string } | null {
  if (!isRecord(value) || !isRecord(value.payload)) return null;
  if (value.channel !== WEB_INBOX_CHANNEL || value.protocolVersion !== WEB_INBOX_VERSION) return null;
  if (typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 200) return null;
  const type = String(value.type || "") as InboxWebRequestType;
  if (![WEB_INBOX_TYPES.getChatsRequest, WEB_INBOX_TYPES.getMessagesRequest, WEB_INBOX_TYPES.sendTextRequest].includes(type)) return null;
  if (!validRequestPayload(type, value.payload)) return null;
  return {
    channel: WEB_INBOX_CHANNEL,
    protocolVersion: WEB_INBOX_VERSION,
    type,
    requestId: value.requestId,
    payload: value.payload
  };
}

function post(request: InboxWebEnvelope & { requestId: string }, type: string, payload: Record<string, unknown>): void {
  const response: InboxWebEnvelope = {
    channel: WEB_INBOX_CHANNEL,
    protocolVersion: WEB_INBOX_VERSION,
    type,
    replyTo: request.requestId,
    payload
  };
  window.postMessage(response, window.location.origin);
}

function failurePayload(error: unknown): Record<string, unknown> {
  const candidate = error as { code?: unknown; message?: unknown; recoverable?: unknown; details?: unknown };
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "UNKNOWN_ERROR",
    message: typeof candidate?.message === "string" ? candidate.message : "No se pudo completar la operación de WhatsApp Inbox.",
    recoverable: candidate?.recoverable !== false,
    ...(candidate?.details && typeof candidate.details === "object" && !Array.isArray(candidate.details)
      ? { details: candidate.details as Record<string, unknown> }
      : {})
  };
}

async function handle(request: InboxWebEnvelope & { type: InboxWebRequestType; requestId: string }): Promise<void> {
  if (request.type === WEB_INBOX_TYPES.getChatsRequest) {
    const data = await sendInboxRuntimeRequest(INBOX_INTERNAL_TYPES.getChats, {
      limit: Number(request.payload.limit || 80)
    }, request.requestId);
    post(request, WEB_INBOX_TYPES.chats, { chats: data });
    return;
  }
  if (request.type === WEB_INBOX_TYPES.getMessagesRequest) {
    const data = await sendInboxRuntimeRequest(INBOX_INTERNAL_TYPES.getMessages, {
      chatId: String(request.payload.chatId || ""),
      limit: Number(request.payload.limit || 50)
    }, request.requestId);
    post(request, WEB_INBOX_TYPES.messages, { conversation: data });
    return;
  }
  const data = await sendInboxRuntimeRequest(INBOX_INTERNAL_TYPES.sendText, {
    chatId: String(request.payload.chatId || ""),
    message: String(request.payload.message || "")
  }, request.requestId);
  post(request, WEB_INBOX_TYPES.textSent, { result: data });
}

function onWindowMessage(event: MessageEvent<unknown>): void {
  if (event.source !== window || event.origin !== window.location.origin || !isAllowedWebAppOrigin(event.origin)) return;
  const request = parseRequest(event.data);
  if (!request) return;
  void handle(request).catch((error: unknown) => post(request, WEB_INBOX_TYPES.error, failurePayload(error)));
}

function installBridge(): void {
  bridgeGlobal.__florMiaWhatsAppInboxBridgeV1?.dispose();
  let active = true;
  const dispose = (): void => {
    if (!active) return;
    active = false;
    window.removeEventListener("message", onWindowMessage);
    if (bridgeGlobal.__florMiaWhatsAppInboxBridgeV1?.dispose === dispose) {
      delete bridgeGlobal.__florMiaWhatsAppInboxBridgeV1;
    }
  };
  bridgeGlobal.__florMiaWhatsAppInboxBridgeV1 = { dispose };
  window.addEventListener("message", onWindowMessage);
}

if (isAllowedWebAppOrigin(window.location.origin)) installBridge();
