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
import { scheduleConversationNavigation, sendAndVerifyText } from "../whatsapp/send-text";
import { sendAndVerifyImage } from "../whatsapp/send-image";
import { reconcileWhatsAppStep } from "../whatsapp/reconcile";
import { waitForConversationContext } from "../whatsapp/conversation-context";

function success<T>(requestId: string, data: T): InternalResponse<T> {
  return { ok: true, requestId, data };
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
    const payload = message.payload as { operationId: string; phoneDigits: string };
    if (!/^\d{8,15}$/.test(payload.phoneDigits)) {
      sendResponse({ ok: false, requestId: message.requestId, error: serializeError(new ExtensionError(ERROR_CODES.invalidInput, "Número interno inválido.")) });
      return false;
    }
    const requestedNavigationAt = new Date().toISOString();
    sendResponse(success<InternalResponseMap["WA_OPEN_CONVERSATION"]>(message.requestId, {
      navigationStarted: true,
      requestedNavigationAt,
      contentInstanceId: CONTENT_INSTANCE_ID
    }));
    logger.info("whatsapp.navigation_scheduled", {
      operationId: payload.operationId,
      requestedNavigationAt,
      contentInstanceId: CONTENT_INSTANCE_ID,
      expectedMaskedPhone: maskPhone(`+${payload.phoneDigits}`)
    });
    scheduleConversationNavigation(payload.phoneDigits);
    return false;
  }

  void (async () => {
    try {
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappPreflight) {
        const data = await runWhatsAppPreflight(message.payload as InternalRequestMap["WA_PREFLIGHT"]);
        sendResponse(success(message.requestId, data));
        return;
      }
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappProveConversation) {
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
        const proveConversationStartedAt = new Date().toISOString();
        let composerObservedAt: string | null = null;
        const data = await waitForConversationContext(payload.phoneDigits, {
          timeoutMs: payload.timeoutMs,
          onObservation: (observation) => {
            if (!composerObservedAt && document.querySelector("#main footer [role='textbox'][contenteditable='true'], #main footer [contenteditable='true']")) {
              composerObservedAt = new Date().toISOString();
            }
            logger.debug("whatsapp.conversation_proof", {
              operationId: payload.operationId,
              contentInstanceId: CONTENT_INSTANCE_ID,
              proveConversationStartedAt,
              requestedNavigationAt: payload.requestedNavigationAt ?? null,
              navigationObservedAt: payload.navigationObservedAt ?? null,
              composerObservedAt,
              ...observation
            });
          }
        });
        sendResponse(success(message.requestId, data));
        return;
      }
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappSendText) {
        const payload = message.payload as InternalRequestMap["WA_SEND_TEXT"];
        const data = await sendAndVerifyText(payload, {
          beforeSend: beforeSendCheckpoint(payload.operationId, payload.checkpointRequired === true)
        });
        sendResponse(success(message.requestId, data));
        return;
      }
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappSendImage) {
        const payload = message.payload as InternalRequestMap["WA_SEND_IMAGE"];
        const data = await sendAndVerifyImage(payload, {
          beforeSend: beforeSendCheckpoint(payload.operationId, payload.checkpointRequired === true)
        });
        sendResponse(success(message.requestId, data));
        return;
      }
      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappReconcileStep) {
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
