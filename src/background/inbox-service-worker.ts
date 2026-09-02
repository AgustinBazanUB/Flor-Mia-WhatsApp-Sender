import { isAllowedWebAppOrigin } from "../config/origins";
import { ContactExportStore } from "../contact-export/contact-export-store";
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
import { StateStore } from "../storage/state-store";

const SEND_CACHE_KEY = "whatsappInboxSendCacheV1";
const MAX_SEND_CACHE = 50;
const stateStore = new StateStore();
const contactExportStore = new ContactExportStore();
const inFlightSends = new Map<string, Promise<InboxResponseMap["INBOX_SEND_TEXT"]>>();

type CachedSend = {
  requestId: string;
  fingerprint: string;
  response: InboxInternalResponse<InboxResponseMap["INBOX_SEND_TEXT"]>;
  completedAt: string;
};

async function requireWhatsAppTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  const tab = tabs.find((item) => typeof item.id === "number");
  if (!tab || typeof tab.id !== "number") throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "WhatsApp Web no está abierto en ninguna pestaña.");
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

function campaignBlocksInbox(status: string | null): boolean {
  // `received` y `ready` también bloquean operaciones que cambian de chat: así se
  // cierra la ventana entre "campaña preparada" y "campaign_start". GET_CHATS
  // sigue siendo permitido porque sólo observa el DOM y no selecciona conversación.
  return Boolean(status && ["received", "ready", "running", "pause_requested", "waiting_contact", "waiting_batch"].includes(status));
}

async function assertOperationCompatible(type: InboxInternalType): Promise<void> {
  const exportState = await contactExportStore.load();
  if (["detecting_labels", "analyzing", "cancelling"].includes(exportState.status)) {
    throw new ExtensionError(ERROR_CODES.campaignConflict, "Contact Export está usando WhatsApp Web. Esperá a que termine o cancelalo antes de usar el Inbox.", {
      recoverable: true,
      details: { inboxReason: "OPERATION_CONFLICT", activeOperation: "contact_export", status: exportState.status }
    });
  }
  if (type === INBOX_INTERNAL_TYPES.getChats) return;
  const state = await stateStore.load();
  const campaignStatus = state.activeCampaign?.status ?? state.currentCampaign?.status ?? null;
  if (campaignBlocksInbox(campaignStatus)) {
    throw new ExtensionError(ERROR_CODES.campaignConflict, "Hay una campaña preparada o activa usando WhatsApp Web. Pausala o finalizala antes de abrir o responder una conversación desde el Inbox.", {
      recoverable: true,
      details: { inboxReason: "OPERATION_CONFLICT", activeOperation: "campaign", status: campaignStatus }
    });
  }
  const checkpoint = state.activeContactProcess;
  if (checkpoint && !["completed", "failed", "paused", "images_required"].includes(checkpoint.status)) {
    throw new ExtensionError(ERROR_CODES.campaignConflict, "Hay una operación de envío activa en WhatsApp Web. Esperá a que termine antes de usar el Inbox.", {
      recoverable: true,
      details: { inboxReason: "OPERATION_CONFLICT", activeOperation: "contact_process", status: checkpoint.status }
    });
  }
}

async function sendToWhatsApp<T extends InboxInternalType>(request: InboxInternalEnvelope<T>): Promise<InboxResponseMap[T]> {
  await assertOperationCompatible(request.type);
  const tab = await requireWhatsAppTab();
  const forwarded = createInboxInternalEnvelope("inbox-service-worker", request.type, request.payload, request.requestId);
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
      { recoverable: response?.error?.recoverable !== false, details: response?.error?.details }
    );
  }
  return response.data;
}

function sendFingerprint(request: InboxInternalEnvelope<typeof INBOX_INTERNAL_TYPES.sendText>): string {
  return `${request.payload.chatId}\u0000${request.payload.message}`;
}

async function loadSendCache(): Promise<CachedSend[]> {
  const result = await chrome.storage.session.get(SEND_CACHE_KEY);
  const value = result[SEND_CACHE_KEY];
  return Array.isArray(value) ? value.filter((item): item is CachedSend => Boolean(item) && typeof item === "object") : [];
}

async function persistSendCache(entry: CachedSend): Promise<void> {
  const cache = await loadSendCache();
  await chrome.storage.session.set({ [SEND_CACHE_KEY]: [...cache.filter((item) => item.requestId !== entry.requestId), entry].slice(-MAX_SEND_CACHE) });
}

async function handleIdempotentSend(request: InboxInternalEnvelope<typeof INBOX_INTERNAL_TYPES.sendText>): Promise<InboxResponseMap["INBOX_SEND_TEXT"]> {
  const fingerprint = sendFingerprint(request);
  const cached = (await loadSendCache()).find((item) => item.requestId === request.requestId);
  if (cached) {
    if (cached.fingerprint !== fingerprint) throw new ExtensionError(ERROR_CODES.protocolError, "El requestId del Inbox ya fue usado con otro payload.", { recoverable: false });
    if (!cached.response.ok || cached.response.data === undefined) {
      throw new ExtensionError(
        isExtensionErrorCode(cached.response.error?.code) ? cached.response.error.code : ERROR_CODES.internal,
        cached.response.error?.message || "La operación anterior del Inbox falló.",
        { recoverable: cached.response.error?.recoverable !== false, details: cached.response.error?.details }
      );
    }
    return cached.response.data;
  }
  const existing = inFlightSends.get(request.requestId);
  if (existing) return existing;
  const operation = sendToWhatsApp(request);
  inFlightSends.set(request.requestId, operation);
  try {
    const data = await operation;
    await persistSendCache({ requestId: request.requestId, fingerprint, response: { ok: true, requestId: request.requestId, data }, completedAt: new Date().toISOString() });
    return data;
  } catch (error) {
    await persistSendCache({ requestId: request.requestId, fingerprint, response: { ok: false, requestId: request.requestId, error: serializeError(error) }, completedAt: new Date().toISOString() });
    throw error;
  } finally {
    inFlightSends.delete(request.requestId);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isInboxInternalEnvelope(message) || message.source !== "web-app-inbox-bridge" || !senderAllowed(sender)) return false;
  if (![INBOX_INTERNAL_TYPES.getChats, INBOX_INTERNAL_TYPES.getMessages, INBOX_INTERNAL_TYPES.sendText].includes(message.type)) return false;

  const operation = message.type === INBOX_INTERNAL_TYPES.sendText
    ? handleIdempotentSend(message as InboxInternalEnvelope<typeof INBOX_INTERNAL_TYPES.sendText>)
    : sendToWhatsApp(message);
  void operation.then(
    (data) => sendResponse({ ok: true, requestId: message.requestId, data }),
    (error: unknown) => sendResponse({ ok: false, requestId: message.requestId, error: serializeError(error) })
  );
  return true;
});
