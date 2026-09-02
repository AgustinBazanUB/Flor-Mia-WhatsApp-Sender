import { serializeError } from "../shared/errors";
import {
  INBOX_INTERNAL_TYPES,
  isInboxInternalEnvelope,
  type InboxRequestMap,
  type InboxResponseMap
} from "../shared/inbox-protocol";
import { getInboxChats, getInboxMessages, sendInboxText } from "../whatsapp/inbox-adapter";

interface InboxRuntimeGuard {
  dispose: () => void;
}

type InboxRuntimeGlobal = typeof globalThis & {
  __florMiaWhatsAppInboxRuntimeV1?: InboxRuntimeGuard;
};

const runtimeGlobal = globalThis as InboxRuntimeGlobal;

function onInboxMessage(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean {
  if (sender.id !== chrome.runtime.id || !isInboxInternalEnvelope(message) || message.source !== "inbox-service-worker") return false;

  void (async () => {
    try {
      if (message.type === INBOX_INTERNAL_TYPES.getChats) {
        const payload = message.payload as InboxRequestMap["INBOX_GET_CHATS"];
        const data: InboxResponseMap["INBOX_GET_CHATS"] = getInboxChats(payload.limit);
        sendResponse({ ok: true, requestId: message.requestId, data });
        return;
      }
      if (message.type === INBOX_INTERNAL_TYPES.getMessages) {
        const payload = message.payload as InboxRequestMap["INBOX_GET_MESSAGES"];
        const data: InboxResponseMap["INBOX_GET_MESSAGES"] = await getInboxMessages(payload.chatId, payload.limit);
        sendResponse({ ok: true, requestId: message.requestId, data });
        return;
      }
      if (message.type === INBOX_INTERNAL_TYPES.sendText) {
        const payload = message.payload as InboxRequestMap["INBOX_SEND_TEXT"];
        const data: InboxResponseMap["INBOX_SEND_TEXT"] = await sendInboxText(payload.chatId, payload.message);
        sendResponse({ ok: true, requestId: message.requestId, data });
        return;
      }
      sendResponse({ ok: false, requestId: message.requestId, error: { code: "PROTOCOL_ERROR", message: "Acción de Inbox no admitida.", recoverable: false } });
    } catch (error) {
      sendResponse({ ok: false, requestId: message.requestId, error: serializeError(error) });
    }
  })();

  return true;
}

function installRuntime(): void {
  runtimeGlobal.__florMiaWhatsAppInboxRuntimeV1?.dispose();
  let active = true;
  const listener = onInboxMessage;
  const dispose = (): void => {
    if (!active) return;
    active = false;
    try {
      chrome.runtime.onMessage.removeListener(listener);
    } catch {
      // Un runtime invalidado no debe ejecutar nuevas acciones sobre WhatsApp.
    }
    if (runtimeGlobal.__florMiaWhatsAppInboxRuntimeV1?.dispose === dispose) {
      delete runtimeGlobal.__florMiaWhatsAppInboxRuntimeV1;
    }
  };
  runtimeGlobal.__florMiaWhatsAppInboxRuntimeV1 = { dispose };
  chrome.runtime.onMessage.addListener(listener);
}

installRuntime();
