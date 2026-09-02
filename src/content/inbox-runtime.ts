import { serializeError } from "../shared/errors";
import {
  INBOX_INTERNAL_TYPES,
  isInboxInternalEnvelope,
  type InboxRequestMap,
  type InboxResponseMap
} from "../shared/inbox-protocol";
import { getInboxChats, getInboxMessages, sendInboxText } from "../whatsapp/inbox-adapter";

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
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
});
