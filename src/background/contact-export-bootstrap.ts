import { ContactExportRuntime } from "./contact-export-runtime";
import { ContactExportStore } from "../contact-export/contact-export-store";
import { createContactExportDiagnosticBundle } from "../contact-export/contact-export-diagnostics";
import { ERROR_CODES, ExtensionError, serializeError } from "../shared/errors";
import {
  INTERNAL_MESSAGE_TYPES,
  isInternalEnvelope,
  type InternalEnvelope,
  type InternalRequestMap
} from "../shared/protocol";
import type { ContactExportLabelResult, ContactExportMetrics } from "../contact-export/types";
import { StateStore } from "../storage/state-store";
import { WhatsAppTransport } from "./whatsapp-transport";
import { resolveWhatsAppLidsInMainWorld } from "../contact-export/whatsapp-main-world-resolver";

const progressChannel = "flormia_contact_export_progress_v1";
const lidResolveChannel = "flormia_contact_export_lid_resolve_v1";
const stateStore = new StateStore();
const runtime = new ContactExportRuntime(new ContactExportStore(), new WhatsAppTransport());

function contactPageSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id
    && sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/contacts/`) === true;
}

function whatsappSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id
    && sender.url?.startsWith("https://web.whatsapp.com/") === true;
}

async function assertContactExportCanRun(): Promise<void> {
  const state = await stateStore.load();
  const campaignStatus = state.activeCampaign?.status ?? state.currentCampaign?.status ?? null;
  if (campaignStatus && !["completed", "stopped"].includes(campaignStatus)) {
    throw new ExtensionError(ERROR_CODES.campaignConflict, "Hay una campaña activa. Pausala o detenela antes de analizar contactos de WhatsApp.");
  }
  const checkpoint = state.activeContactProcess;
  if (checkpoint && !["completed", "failed"].includes(checkpoint.status)) {
    throw new ExtensionError(ERROR_CODES.campaignConflict, "Hay un contacto de prueba activo o pausado. Finalizalo antes de analizar contactos de WhatsApp.");
  }
}

async function dispatchContactPage(request: InternalEnvelope): Promise<unknown> {
  switch (request.type) {
    case INTERNAL_MESSAGE_TYPES.getState:
      return stateStore.load();
    case INTERNAL_MESSAGE_TYPES.contactExportGetState:
      return runtime.getState();
    case INTERNAL_MESSAGE_TYPES.contactExportDetectLabels:
      await assertContactExportCanRun();
      return runtime.detectLabels();
    case INTERNAL_MESSAGE_TYPES.contactExportAnalyze:
      await assertContactExportCanRun();
      return runtime.analyze((request.payload as InternalRequestMap["CONTACT_EXPORT_ANALYZE"]).selectedLabelIds);
    case INTERNAL_MESSAGE_TYPES.contactExportCancel:
      return runtime.cancel();
    case INTERNAL_MESSAGE_TYPES.contactExportReset:
      return runtime.reset();
    case INTERNAL_MESSAGE_TYPES.generateDiagnosticReport: {
      const state = await runtime.getState();
      return createContactExportDiagnosticBundle(state, chrome.runtime.getManifest().version);
    }
    default:
      throw new ExtensionError(ERROR_CODES.protocolError, "Acción del módulo Contactos no admitida.", { recoverable: false });
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isInternalEnvelope(message) && message.source === "contact-export-page" && contactPageSender(sender)) {
    void dispatchContactPage(message).then(
      (data) => sendResponse({ ok: true, requestId: message.requestId, data }),
      (error: unknown) => sendResponse({ ok: false, requestId: message.requestId, error: serializeError(error) })
    );
    return true;
  }

  if (
    whatsappSender(sender)
    && message
    && typeof message === "object"
    && (message as Record<string, unknown>).channel === lidResolveChannel
  ) {
    const payload = message as Record<string, unknown>;
    const operationId = typeof payload.operationId === "string" ? payload.operationId : "";
    const contactIds = Array.isArray(payload.contactIds)
      ? payload.contactIds.filter((item): item is string => typeof item === "string").slice(0, 1000)
      : [];
    const tabId = sender.tab?.id;
    if (!operationId || typeof tabId !== "number" || !contactIds.length) {
      sendResponse({ ok: false, phones: {} });
      return false;
    }
    void (async () => {
      const state = await runtime.getState();
      if (state.status !== "analyzing" || state.operationId !== operationId) return { phones: {} };
      const resolved = await resolveWhatsAppLidsInMainWorld(tabId, contactIds);
      return { phones: resolved.phones };
    })().then(
      (data) => sendResponse({ ok: true, ...data }),
      () => sendResponse({ ok: false, phones: {} })
    );
    return true;
  }

  if (
    whatsappSender(sender)
    && message
    && typeof message === "object"
    && (message as Record<string, unknown>).channel === progressChannel
  ) {
    const payload = message as Record<string, unknown>;
    const operationId = typeof payload.operationId === "string" ? payload.operationId : "";
    if (!operationId) return false;
    void runtime.recordProgress({
      operationId,
      processed: Number(payload.processed || 0),
      totalHint: payload.totalHint == null ? null : Number(payload.totalHint),
      percent: payload.percent == null ? null : Number(payload.percent),
      currentLabel: typeof payload.currentLabel === "string" ? payload.currentLabel : null,
      labelIndex: Number(payload.labelIndex || 0),
      totalLabels: Number(payload.totalLabels || 0),
      currentContact: Number(payload.currentContact || 0),
      ...(payload.metrics && typeof payload.metrics === "object" ? { metrics: payload.metrics as ContactExportMetrics } : {}),
      ...(Array.isArray(payload.labelResults) ? { labelResults: payload.labelResults as ContactExportLabelResult[] } : {})
    } as InternalRequestMap["CONTACT_EXPORT_PROGRESS"]).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    );
    return true;
  }

  return false;
});
