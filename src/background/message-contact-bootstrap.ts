import { MessageContactRuntime } from "./message-contact-runtime";
import { ContactExportStore } from "../contact-export/contact-export-store";
import { MessageContactStore } from "../contact-export/message-contact-store";
import {
  isMessageContactEnvelope,
  MESSAGE_CONTACT_TYPES,
  type MessageContactEnvelope,
  type MessageContactRequestMap
} from "../contact-export/message-contact-protocol";
import { ERROR_CODES, ExtensionError, serializeError } from "../shared/errors";
import { StateStore } from "../storage/state-store";
import { WhatsAppTransport } from "./whatsapp-transport";

const stateStore = new StateStore();
const runtime = new MessageContactRuntime(new MessageContactStore(), new ContactExportStore(), new WhatsAppTransport());

function contactPageSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id
    && sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/contacts/`) === true;
}

async function assertCanUseMessageContacts(): Promise<void> {
  const state = await stateStore.load();
  const campaignStatus = state.activeCampaign?.status ?? state.currentCampaign?.status ?? null;
  if (campaignStatus && !["completed", "stopped"].includes(campaignStatus)) {
    throw new ExtensionError(ERROR_CODES.campaignConflict, "Hay una campaña activa. Pausala o detenela antes de modificar listas de contactos.");
  }
  const checkpoint = state.activeContactProcess;
  if (checkpoint && !["completed", "failed"].includes(checkpoint.status)) {
    throw new ExtensionError(ERROR_CODES.campaignConflict, "Hay un contacto de prueba activo o pausado. Finalizalo antes de modificar listas de contactos.");
  }
}

async function dispatch(request: MessageContactEnvelope): Promise<unknown> {
  switch (request.type) {
    case MESSAGE_CONTACT_TYPES.getState:
      return runtime.getState();
    case MESSAGE_CONTACT_TYPES.search:
      await assertCanUseMessageContacts();
      return runtime.search(request.payload as MessageContactRequestMap["MESSAGE_CONTACT_SEARCH"]);
    case MESSAGE_CONTACT_TYPES.assign:
      await assertCanUseMessageContacts();
      return runtime.startAssignment();
    case MESSAGE_CONTACT_TYPES.pause:
      return runtime.pause();
    case MESSAGE_CONTACT_TYPES.resume:
      await assertCanUseMessageContacts();
      return runtime.resume();
    case MESSAGE_CONTACT_TYPES.cancel:
      return runtime.cancel();
    case MESSAGE_CONTACT_TYPES.refreshList:
      await assertCanUseMessageContacts();
      return runtime.refreshList();
    case MESSAGE_CONTACT_TYPES.reset:
      return runtime.reset();
    default:
      throw new ExtensionError(ERROR_CODES.protocolError, "Acción de Agregar contactos por frase no admitida.", { recoverable: false });
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isMessageContactEnvelope(message) || !contactPageSender(sender)) return false;
  void dispatch(message).then(
    (data) => sendResponse({ ok: true, requestId: message.requestId, data }),
    (error: unknown) => sendResponse({ ok: false, requestId: message.requestId, error: serializeError(error) })
  );
  return true;
});
