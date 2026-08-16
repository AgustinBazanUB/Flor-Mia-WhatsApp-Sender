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
import { runWhatsAppPreflight } from "../whatsapp/preflight";
import { scheduleConversationNavigation, sendAndVerifyText } from "../whatsapp/send-text";
import { sendAndVerifyImage } from "../whatsapp/send-image";
import { reconcileWhatsAppStep } from "../whatsapp/reconcile";

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
    sendResponse(success<InternalResponseMap["WA_OPEN_CONVERSATION"]>(message.requestId, { navigationStarted: true }));
    logger.info("whatsapp.navigation_scheduled", { operationId: payload.operationId, phone: payload.phoneDigits });
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

logger.debug("whatsapp.content_ready", { origin: window.location.origin });
