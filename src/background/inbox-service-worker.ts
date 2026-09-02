import { isAllowedWebAppOrigin } from "../config/origins";
import { ERROR_CODES, ExtensionError, isExtensionErrorCode, serializeError } from "../shared/errors";
import {
  createInboxInternalEnvelope,
  INBOX_INTERNAL_TYPES,
  isInboxInternalEnvelope,
  type InboxInternalEnvelope,
  type InboxInternalType,
  type InboxInternalResponse,
  type InboxResponseMap
} from "../shared/inbox-protocol";

async function requireWhatsAppTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  const tab = tabs.find((item) => typeof item.id === "number");
  if (!tab || typeof tab.id !== "number") {
    throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "WhatsApp Web no está abierto en ninguna pestaña.");
  }
  return tab as chrome.tabs.Tab & { id: number };
}

function senderAllowed(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  try {
    return Boolean(sender.url && isAllowedWebAppOrigin(new URL(sender.url).origin));
  } catch {
    return false;
  }
}

async function sendToWhatsApp<T extends InboxInternalType>(
  request: InboxInternalEnvelope<T>
): Promise<InboxResponseMap[T]> {
  const tab = await requireWhatsAppTab();
  const forwarded = createInboxInternalEnvelope(
    "inbox-service-worker",
    request.type,
    request.payload,
    request.requestId
  );
  let response: InboxInternalResponse<InboxResponseMap[T]> | undefined;
  try {
    response = await chrome.tabs.sendMessage(tab.id, forwarded) as InboxInternalResponse<InboxResponseMap[T]> | undefined;
  } catch (error) {
    throw new ExtensionError(ERROR_CODES.interfaceLoading, "WhatsApp Web está abierto, pero el Inbox todavía no puede comunicarse con la pestaña.", {
      cause: error,
      details: { inboxReason: "MESSAGES_NOT_AVAILABLE" }
    });
  }
  if (!response?.ok || response.data === undefined) {
    const remoteCode = response?.error?.code;
    throw new ExtensionError(
      isExtensionErrorCode(remoteCode) ? remoteCode : ERROR_CODES.internal,
      response?.error?.message || "WhatsApp Web no respondió al Inbox.",
      {
        recoverable: response?.error?.recoverable !== false,
        details: response?.error?.details
      }
    );
  }
  return response.data;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isInboxInternalEnvelope(message) || message.source !== "web-app-inbox-bridge" || !senderAllowed(sender)) return false;
  if (![INBOX_INTERNAL_TYPES.getChats, INBOX_INTERNAL_TYPES.getMessages, INBOX_INTERNAL_TYPES.sendText].includes(message.type)) return false;

  void sendToWhatsApp(message).then(
    (data) => sendResponse({ ok: true, requestId: message.requestId, data }),
    (error: unknown) => sendResponse({ ok: false, requestId: message.requestId, error: serializeError(error) })
  );
  return true;
});
