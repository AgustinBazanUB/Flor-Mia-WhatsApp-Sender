import { isAllowedWebAppOrigin } from "../config/origins";
import {
  INBOX_INTERNAL_TYPES,
  sendInboxRuntimeRequest
} from "../shared/inbox-protocol";
import {
  isWebAppInboundEnvelope,
  PROTOCOL_VERSION,
  WEB_APP_CHANNEL,
  WEB_APP_MESSAGE_TYPES,
  type WebAppEnvelope
} from "../shared/protocol";

const INBOX_REQUEST_TYPES = new Set([
  WEB_APP_MESSAGE_TYPES.inboxGetChatsRequest,
  WEB_APP_MESSAGE_TYPES.inboxGetMessagesRequest,
  WEB_APP_MESSAGE_TYPES.inboxSendTextRequest
]);

interface InboxBridgeGuard {
  dispose: () => void;
}

type InboxBridgeGlobal = typeof globalThis & {
  __florMiaWhatsAppInboxBridgeV1?: InboxBridgeGuard;
};

const bridgeGlobal = globalThis as InboxBridgeGlobal;

function post(request: WebAppEnvelope, type: WebAppEnvelope["type"], payload: Record<string, unknown>): void {
  window.postMessage({
    channel: WEB_APP_CHANNEL,
    protocolVersion: PROTOCOL_VERSION,
    type,
    replyTo: request.requestId,
    payload
  } satisfies WebAppEnvelope, window.location.origin);
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

async function handle(request: WebAppEnvelope): Promise<void> {
  if (request.type === WEB_APP_MESSAGE_TYPES.inboxGetChatsRequest) {
    const data = await sendInboxRuntimeRequest(INBOX_INTERNAL_TYPES.getChats, {
      limit: Number(request.payload.limit || 80)
    }, request.requestId);
    post(request, WEB_APP_MESSAGE_TYPES.inboxChats, { chats: data });
    return;
  }
  if (request.type === WEB_APP_MESSAGE_TYPES.inboxGetMessagesRequest) {
    const data = await sendInboxRuntimeRequest(INBOX_INTERNAL_TYPES.getMessages, {
      chatId: String(request.payload.chatId || ""),
      limit: Number(request.payload.limit || 50)
    }, request.requestId);
    post(request, WEB_APP_MESSAGE_TYPES.inboxMessages, { conversation: data });
    return;
  }
  if (request.type === WEB_APP_MESSAGE_TYPES.inboxSendTextRequest) {
    const data = await sendInboxRuntimeRequest(INBOX_INTERNAL_TYPES.sendText, {
      chatId: String(request.payload.chatId || ""),
      message: String(request.payload.message || "")
    }, request.requestId);
    post(request, WEB_APP_MESSAGE_TYPES.inboxTextSent, { result: data });
  }
}

function onWindowMessage(event: MessageEvent<unknown>): void {
  if (event.source !== window || event.origin !== window.location.origin || !isAllowedWebAppOrigin(event.origin)) return;
  if (!isWebAppInboundEnvelope(event.data) || !INBOX_REQUEST_TYPES.has(event.data.type)) return;
  const request = event.data;
  void handle(request).catch((error: unknown) => {
    post(request, WEB_APP_MESSAGE_TYPES.inboxError, failurePayload(error));
  });
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
