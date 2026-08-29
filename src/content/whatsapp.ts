import { ERROR_CODES, ExtensionError, serializeError } from "../shared/errors";
import {
  INTERNAL_MESSAGE_TYPES,
  isInternalEnvelope,
  sendRuntimeRequest,
  type InternalRequestMap,
  type InternalResponse,
  type InternalResponseMap
} from "../shared/protocol";
import { logger } from "../shared/logger";
import { maskPhone } from "../shared/phone";
import { CONTENT_INSTANCE_ID, runWhatsAppPreflight } from "../whatsapp/preflight";
import { installConversationInteractionGuard } from "../whatsapp/conversation-guard";
import { scheduleConversationNavigation, sendAndVerifyText } from "../whatsapp/send-text";
import { sendAndVerifyImage } from "../whatsapp/send-image";
import { reconcileWhatsAppStep } from "../whatsapp/reconcile";
import { waitForConversationContext } from "../whatsapp/conversation-context";
import { snapshotRuntimeMetrics } from "../performance/runtime-metrics";
import {
  collectContactsForLabels,
  detectWhatsAppLabels
} from "../contact-export/whatsapp-contact-adapter";
import { CONTACT_EXPORT_ERROR_CODES, type ContactExportProgress } from "../contact-export/types";

const proofControllers = new Map<string, AbortController>();
const contactExportControllers = new Map<string, AbortController>();
const CONTACT_EXPORT_PROGRESS_CHANNEL = "flormia_contact_export_progress_v1";
installConversationInteractionGuard(document);

function success<T>(requestId: string, data: T): InternalResponse<T> {
  return { ok: true, requestId, data };
}

function abortActiveContactExports(reason: string): void {
  if (!contactExportControllers.size) return;
  for (const controller of contactExportControllers.values()) controller.abort();
  logger.info("contact_export.preempted", { reason, activeOperations: contactExportControllers.size });
}

async function publishContactExportProgress(
  operationId: string,
  progress: Omit<ContactExportProgress, "operationId" | "updatedAt">
): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      channel: CONTACT_EXPORT_PROGRESS_CHANNEL,
      operationId,
      ...progress
    });
  } catch {
    // El progreso es informativo. Una pérdida temporal del listener de background
    // no debe detener la extracción ni reenviar información a servicios externos.
  }
}

function beforeSendCheckpoint(operationId: string, required: boolean) {
  return async (baselineOutgoingIds: string[]): Promise<void> => {
    const result = await sendRuntimeRequest("whatsapp-content", INTERNAL_MESSAGE_TYPES.whatsappOperationStage, {
      operationId,
      stage: "send_attempted",
      baselineOutgoingIds
    });
    if (required && !result.recorded) {
      throw new ExtensionError(ERROR_CODES.storageError, "No se pudo guardar el checkpoint previo al envío.");
    }
  };
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isInternalEnvelope(message) || message.source !== "service-worker") return false;

  if (message.type === INTERNAL_MESSAGE_TYPES.whatsappOpenConversation) {
    abortActiveContactExports("sender_open_conversation");
    const payload = message.payload as InternalRequestMap["WA_OPEN_CONVERSATION"];
    if (!/^\d{8,15}$/.test(payload.phoneDigits) || !payload.navigationRequestId) {
      sendResponse({ ok: false, requestId: message.requestId, error: serializeError(new ExtensionError(ERROR_CODES.invalidInput, "Navegación interna inválida.")) });
      return false;
    }
    const requestedNavigationAt = new Date().toISOString();
    sendResponse(success<InternalResponseMap["WA_OPEN_CONVERSATION"]>(message.requestId, {
      navigationStarted: true,
      requestedNavigationAt,
      contentInstanceId: CONTENT_INSTANCE_ID,
      navigationRequestId: payload.navigationRequestId
    }));
    logger.info("whatsapp.navigation_scheduled", {
      operationId: payload.operationId,
      navigationRequestId: payload.navigationRequestId,
      requestedNavigationAt,
      contentInstanceId: CONTENT_INSTANCE_ID,
      expectedMaskedPhone: maskPhone(`+${payload.phoneDigits}`)
    });
    scheduleConversationNavigation(payload.phoneDigits);
    return false;
  }

  if (message.type === INTERNAL_MESSAGE_TYPES.whatsappCancelOperation) {
    const payload = message.payload as InternalRequestMap["WA_CANCEL_OPERATION"];
    const controller = proofControllers.get(payload.operationId);
    controller?.abort();
    sendResponse(success<InternalResponseMap["WA_CANCEL_OPERATION"]>(message.requestId, { cancelled: Boolean(controller) }));
    return false;
  }

  if (message.type === INTERNAL_MESSAGE_TYPES.whatsappContactExportCancel) {
    const payload = message.payload as InternalRequestMap["WA_CONTACT_EXPORT_CANCEL"];
    const controller = contactExportControllers.get(payload.operationId);
    controller?.abort();
    sendResponse(success<InternalResponseMap["WA_CONTACT_EXPORT_CANCEL"]>(message.requestId, { cancelled: Boolean(controller) }));
    return false;
  }

  void (async () => {
    try {
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappDiagnosticSnapshot) {
        sendResponse(success(message.requestId, {
          contentInstanceId: CONTENT_INSTANCE_ID,
          documentReadyState: document.readyState,
          composerPresent: Boolean(document.querySelector("#main footer [role='textbox'][contenteditable='true'], #main footer [contenteditable='true']")),
          activeProofControllers: proofControllers.size,
          activeContactExportControllers: contactExportControllers.size,
          runtimeMetrics: snapshotRuntimeMetrics() as unknown as Record<string, unknown>
        }));
        return;
      }
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappPreflight) {
        const data = await runWhatsAppPreflight(message.payload as InternalRequestMap["WA_PREFLIGHT"]);
        sendResponse(success(message.requestId, data));
        return;
      }
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappContactExportDetectLabels) {
        const data = await detectWhatsAppLabels();
        sendResponse(success<InternalResponseMap["WA_CONTACT_EXPORT_DETECT_LABELS"]>(message.requestId, data));
        return;
      }
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappContactExportAnalyze) {
        const payload = message.payload as InternalRequestMap["WA_CONTACT_EXPORT_ANALYZE"];
        const controller = new AbortController();
        contactExportControllers.set(payload.operationId, controller);
        try {
          const collection = await collectContactsForLabels(payload.labels, {
            signal: controller.signal,
            progress: (progress) => publishContactExportProgress(payload.operationId, progress)
          });
          await publishContactExportProgress(payload.operationId, {
            processed: collection.candidates.length,
            totalHint: collection.candidates.length,
            percent: 100,
            currentLabel: payload.labels.at(-1)?.name ?? null,
            labelIndex: payload.labels.length,
            totalLabels: payload.labels.length,
            currentContact: collection.candidates.length,
            metrics: collection.metrics,
            labelResults: collection.labelResults
          });
          sendResponse(success<InternalResponseMap["WA_CONTACT_EXPORT_ANALYZE"]>(message.requestId, {
            candidates: collection.candidates,
            strategy: collection.strategy
          }));
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            throw new ExtensionError(ERROR_CODES.contactExportCancelled, "La extracción de contactos fue cancelada.", {
              recoverable: true,
              details: {
                contactExportCode: CONTACT_EXPORT_ERROR_CODES.cancelled,
                stage: "cancelled",
                strategy: "label-scoped-phone-first-no-chat-opening"
              }
            });
          }
          throw error;
        } finally {
          if (contactExportControllers.get(payload.operationId) === controller) contactExportControllers.delete(payload.operationId);
        }
        return;
      }
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappProveConversation) {
        abortActiveContactExports("sender_prove_conversation");
        const payload = message.payload as InternalRequestMap["WA_PROVE_CONVERSATION"];
        if (payload.expectedContentInstanceId && payload.expectedContentInstanceId !== CONTENT_INSTANCE_ID) {
          throw new ExtensionError(
            ERROR_CODES.interfaceLoading,
            "WhatsApp cambió de documento antes de confirmar el contacto. Se esperará la nueva instancia de forma segura.",
            {
              recoverable: true,
              details: { contentGenerationMismatch: true }
            }
          );
        }
        if (!payload.navigationRequestId || !payload.requestedNavigationAt || !payload.navigationObservedAt) {
          throw new ExtensionError(ERROR_CODES.contactContextUnverified, "Falta la cadena causal de navegación necesaria para confirmar el contacto.", {
            recoverable: true,
            details: { proofFailureReason: "stale_navigation", retryWithoutNewEvidence: false }
          });
        }
        const proveConversationStartedAt = new Date().toISOString();
        let composerObservedAt: string | null = null;
        const controller = new AbortController();
        proofControllers.set(payload.operationId, controller);
        try {
          const data = await waitForConversationContext(payload.phoneDigits, {
            timeoutMs: payload.timeoutMs,
            signal: controller.signal,
            causalNavigation: {
              navigationRequestId: payload.navigationRequestId,
              contentInstanceId: CONTENT_INSTANCE_ID,
              requestedNavigationAt: payload.requestedNavigationAt,
              navigationObservedAt: payload.navigationObservedAt
            },
            onObservation: (observation) => {
              if (!composerObservedAt && document.querySelector("#main footer [role='textbox'][contenteditable='true'], #main footer [contenteditable='true']")) {
                composerObservedAt = new Date().toISOString();
              }
              logger.debug("whatsapp.conversation_proof", {
                operationId: payload.operationId,
                navigationRequestId: payload.navigationRequestId,
                contentInstanceId: CONTENT_INSTANCE_ID,
                proveConversationStartedAt,
                requestedNavigationAt: payload.requestedNavigationAt,
                navigationObservedAt: payload.navigationObservedAt,
                composerObservedAt,
                ...observation
              });
            }
          });
          sendResponse(success(message.requestId, data));
        } finally {
          if (proofControllers.get(payload.operationId) === controller) proofControllers.delete(payload.operationId);
        }
        return;
      }
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappSendText) {
        abortActiveContactExports("sender_send_text");
        const payload = message.payload as InternalRequestMap["WA_SEND_TEXT"];
        const data = await sendAndVerifyText(payload, {
          beforeSend: beforeSendCheckpoint(payload.operationId, payload.checkpointRequired === true)
        });
        sendResponse(success(message.requestId, data));
        return;
      }
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappSendImage) {
        abortActiveContactExports("sender_send_image");
        const payload = message.payload as InternalRequestMap["WA_SEND_IMAGE"];
        const data = await sendAndVerifyImage(payload, {
          beforeSend: beforeSendCheckpoint(payload.operationId, payload.checkpointRequired === true)
        });
        sendResponse(success(message.requestId, data));
        return;
      }
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappReconcileStep) {
        abortActiveContactExports("sender_reconcile");
        const data = await reconcileWhatsAppStep(message.payload as Parameters<typeof reconcileWhatsAppStep>[0]);
        sendResponse(success(message.requestId, data));
        return;
      }
      sendResponse({ ok: false, requestId: message.requestId, error: { code: "PROTOCOL_ERROR", message: "Acción de WhatsApp no admitida.", recoverable: false } });
    } catch (error) {
      const serialized = serializeError(error);
      logger.error("whatsapp.action_failed", { type: message.type, errorCode: serialized.code });
      sendResponse({ ok: false, requestId: message.requestId, error: serialized });
    }
  })();
  return true;
});

logger.debug("whatsapp.content_ready", { origin: window.location.origin, contentInstanceId: CONTENT_INSTANCE_ID });
