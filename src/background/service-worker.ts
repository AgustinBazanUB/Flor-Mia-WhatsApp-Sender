import { isAllowedWebAppOrigin } from "../config/origins";
import { validateCampaignInput } from "../shared/campaign";
import { ERROR_CODES, ExtensionError, isExtensionErrorCode, serializeError, toExtensionError } from "../shared/errors";
import { createId } from "../shared/ids";
import { logger } from "../shared/logger";
import { normalizePhone } from "../shared/phone";
import {
  createInternalRequest,
  INTERNAL_MESSAGE_TYPES,
  isInternalEnvelope,
  type InternalEnvelope,
  type InternalMessageType,
  type InternalRequestMap,
  type InternalResponse,
  type InternalResponseMap
} from "../shared/protocol";
import { deserializeCampaign, type SerializedCampaignPayload } from "../shared/serialization";
import type { TextTestResult, WhatsAppPreflightResult } from "../shared/state";
import { CampaignBlobStore } from "../storage/blob-store";
import { StateStore } from "../storage/state-store";

const stateStore = new StateStore();
const blobStore = new CampaignBlobStore();
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

async function initialize(): Promise<void> {
  const state = await stateStore.load();
  await stateStore.save(state);
  logger.info("service_worker.initialized", { version: EXTENSION_VERSION, state: state.status });
}

chrome.runtime.onInstalled.addListener(() => void initialize());
chrome.runtime.onStartup.addListener(() => void initialize());

function unavailablePreflight(message: string): WhatsAppPreflightResult {
  return {
    checkedAt: new Date().toISOString(),
    pageDetected: false,
    documentReady: false,
    sessionReady: false,
    mainInterfaceReady: false,
    qrDetected: false,
    operational: false,
    status: "unavailable",
    message,
    capabilities: {
      openConversation: { state: "unavailable", message },
      composer: { state: "unavailable", message },
      sendText: { state: "unavailable", message },
      multimedia: { state: "notImplemented", message: "El envío multimedia se implementará en el Prompt 2." }
    }
  };
}

async function findWhatsAppTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  return tabs.find((tab) => typeof tab.id === "number") ?? null;
}

async function sendTabRequest<T extends InternalMessageType>(
  tabId: number,
  type: T,
  payload: InternalRequestMap[T]
): Promise<InternalResponseMap[T]> {
  const request = createInternalRequest("service-worker", type, payload);
  const response = await chrome.tabs.sendMessage(tabId, request) as InternalResponse<InternalResponseMap[T]> | undefined;
  if (!response?.ok || response.data === undefined) {
    throw new ExtensionError(
      isExtensionErrorCode(response?.error?.code) ? response.error.code : ERROR_CODES.internal,
      response?.error?.message || "WhatsApp Web no respondió.",
      { details: { remoteErrorCode: response?.error?.code, ...response?.error?.details } }
    );
  }
  return response.data;
}

async function waitForWhatsAppContent(tabId: number, timeoutMs: number): Promise<WhatsAppPreflightResult> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await sendTabRequest(tabId, INTERNAL_MESSAGE_TYPES.whatsappPreflight, { timeoutMs: 1_000 });
      if (result.documentReady && (result.operational || result.qrDetected)) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
  }
  throw new ExtensionError(ERROR_CODES.timeout, "WhatsApp Web no quedó listo después de abrir la conversación.", { cause: lastError });
}

async function preparePreflightState(): Promise<void> {
  const current = await stateStore.load();
  if (current.status === "running" || current.status === "pausing" || current.status === "paused") {
    throw new ExtensionError(ERROR_CODES.internal, "No se puede ejecutar un diagnóstico mientras hay una operación activa.");
  }
  if (current.status === "completed" || current.status === "error") await stateStore.transition("idle");
  await stateStore.transition("preflight", { currentStep: "preflight", operational: false, statusMessage: "Comprobando WhatsApp Web…" });
}

async function runPreflight(timeoutMs = 8_000): Promise<WhatsAppPreflightResult> {
  await preparePreflightState();
  const tab = await findWhatsAppTab();
  if (!tab?.id) {
    const result = unavailablePreflight("WhatsApp Web no está abierto en ninguna pestaña.");
    await stateStore.transition("error", { whatsapp: result, operational: false, statusMessage: result.message, currentStep: null });
    return result;
  }
  try {
    const result = await sendTabRequest(tab.id, INTERNAL_MESSAGE_TYPES.whatsappPreflight, { timeoutMs });
    if (result.operational) {
      await stateStore.transition("ready", { whatsapp: result, operational: true, statusMessage: result.message, currentStep: null });
    } else {
      await stateStore.transition("error", { whatsapp: result, operational: false, statusMessage: result.message, currentStep: null });
    }
    await stateStore.appendOperation({
      operationId: createId("diagnostic"), kind: "diagnostic", success: result.operational,
      startedAt: result.checkedAt, completedAt: new Date().toISOString()
    });
    return result;
  } catch (error) {
    const normalized = toExtensionError(error, ERROR_CODES.interfaceLoading);
    const result = unavailablePreflight(normalized.message);
    await stateStore.transition("error", { whatsapp: result, operational: false, statusMessage: result.message, currentStep: null });
    await stateStore.appendError({ ...serializeError(normalized), at: new Date().toISOString() });
    return result;
  }
}

function failedTextResult(operationId: string, maskedPhone: string, startedAt: string, error: unknown): TextTestResult {
  return {
    success: false,
    operationId,
    contactId: "unconfirmed",
    maskedPhone,
    step: "text",
    startedAt,
    completedAt: new Date().toISOString(),
    verification: { confirmed: false, method: "none" },
    error: serializeError(error)
  };
}

async function sendTestText(payload: InternalRequestMap["SEND_TEST_TEXT"]): Promise<TextTestResult> {
  const operationId = createId("text-test");
  const startedAt = new Date().toISOString();
  let maskedPhone = "";
  try {
    const phone = normalizePhone(payload.phone);
    maskedPhone = phone.masked;
    const message = String(payload.message ?? "").trim();
    if (!message) throw new ExtensionError(ERROR_CODES.invalidInput, "Ingresá un mensaje de prueba.");
    if (message.length > 4_096) throw new ExtensionError(ERROR_CODES.invalidInput, "El mensaje de prueba supera 4.096 caracteres.");

    const preflight = await runPreflight();
    if (!preflight.operational) throw new ExtensionError(
      preflight.qrDetected ? ERROR_CODES.sessionNotReady : ERROR_CODES.whatsappNotOpen,
      preflight.message
    );
    const tab = await findWhatsAppTab();
    if (!tab?.id) throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "WhatsApp Web dejó de estar disponible.");

    await stateStore.transition("running", {
      currentContact: { recipientId: operationId, phone: phone.e164, maskedPhone: phone.masked },
      currentStep: "open-conversation",
      lastCheckpoint: { operationId, recipientId: operationId, step: "preflight-complete", createdAt: new Date().toISOString() },
      statusMessage: "Abriendo la conversación de prueba…"
    });
    await sendTabRequest(tab.id, INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, { operationId, phoneDigits: phone.digits });
    await stateStore.patch({
      currentStep: "wait-conversation",
      lastCheckpoint: { operationId, recipientId: operationId, step: "navigation-requested", createdAt: new Date().toISOString() }
    });
    await waitForWhatsAppContent(tab.id, 30_000);
    await stateStore.patch({ currentStep: "send-text", statusMessage: "Enviando y verificando el mensaje de prueba…" });
    const result = await sendTabRequest(tab.id, INTERNAL_MESSAGE_TYPES.whatsappSendText, {
      operationId,
      phoneDigits: phone.digits,
      message
    });
    if (!result.success || !result.verification.confirmed) {
      throw new ExtensionError(ERROR_CODES.verificationFailed, "WhatsApp no confirmó el mensaje saliente.");
    }
    await stateStore.transition("completed", {
      lastTestResult: result,
      currentStep: null,
      currentContact: null,
      operational: true,
      statusMessage: "La prueba de texto fue enviada y verificada.",
      lastCheckpoint: { operationId, recipientId: operationId, step: "verified", createdAt: result.completedAt }
    });
    await stateStore.appendOperation({
      operationId, kind: "text-test", success: true, startedAt, completedAt: result.completedAt, maskedPhone
    });
    logger.info("text_test.completed", { operationId, phone: phone.e164, verification: result.verification.method });
    return result;
  } catch (error) {
    const normalized = toExtensionError(error);
    const result = failedTextResult(operationId, maskedPhone, startedAt, normalized);
    const current = await stateStore.load();
    if (current.status !== "error") await stateStore.transition("error", {
      lastTestResult: result, currentStep: null, currentContact: null, operational: false, statusMessage: normalized.message
    });
    else await stateStore.patch({ lastTestResult: result, currentStep: null, currentContact: null, operational: false, statusMessage: normalized.message });
    await stateStore.appendError({ ...serializeError(normalized), at: new Date().toISOString() });
    await stateStore.appendOperation({
      operationId, kind: "text-test", success: false, startedAt, completedAt: result.completedAt,
      ...(maskedPhone ? { maskedPhone } : {}), errorCode: normalized.code
    });
    logger.error("text_test.failed", { operationId, phone: maskedPhone, errorCode: normalized.code });
    return result;
  }
}

async function acceptCampaign(payload: SerializedCampaignPayload): Promise<InternalResponseMap["WEB_APP_PREPARE_CAMPAIGN"]> {
  const campaign = validateCampaignInput(deserializeCampaign(payload));
  await blobStore.deleteCampaign(campaign.campaignId);
  await blobStore.putCampaignImages(campaign.campaignId, campaign.images.map((image) => ({
    imageId: `image-${image.order}`,
    order: image.order,
    name: image.name,
    type: image.type,
    blob: new Blob([image.data], { type: image.type })
  })));
  const acceptedAt = new Date().toISOString();
  await stateStore.patch({
    currentCampaign: {
      campaignId: campaign.campaignId,
      campaignName: campaign.campaignName,
      createdBy: campaign.createdBy,
      totalRecipients: campaign.totalRecipients,
      messageLength: campaign.message.length,
      imageCount: campaign.imageCount,
      receivedAt: acceptedAt,
      status: "received"
    },
    progress: { total: campaign.totalRecipients, sent: 0, failed: 0 },
    statusMessage: "Campaña recibida y preparada localmente."
  });
  await stateStore.appendOperation({
    operationId: createId("campaign"), kind: "campaign-received", success: true, startedAt: acceptedAt, completedAt: acceptedAt
  });
  return { campaignId: campaign.campaignId, acceptedAt };
}

async function cancelCampaign(campaignId: string): Promise<InternalResponseMap["WEB_APP_CANCEL_CAMPAIGN"]> {
  if (!campaignId.trim()) throw new ExtensionError(ERROR_CODES.invalidInput, "campaignId es obligatorio.");
  await blobStore.deleteCampaign(campaignId);
  const state = await stateStore.load();
  if (state.currentCampaign?.campaignId === campaignId) {
    await stateStore.patch({ currentCampaign: { ...state.currentCampaign, status: "cancelled" }, progress: { total: 0, sent: 0, failed: 0 } });
  }
  return { campaignId, cancelledAt: new Date().toISOString() };
}

function senderAllowed(request: InternalEnvelope, sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (request.source === "popup") return sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/popup/`) === true;
  if (request.source === "web-app-bridge") {
    try { return Boolean(sender.url && isAllowedWebAppOrigin(new URL(sender.url).origin)); } catch { return false; }
  }
  return false;
}

async function handleRequest(request: InternalEnvelope): Promise<unknown> {
  switch (request.type) {
    case INTERNAL_MESSAGE_TYPES.getState:
      return stateStore.load();
    case INTERNAL_MESSAGE_TYPES.runPreflight:
      return runPreflight();
    case INTERNAL_MESSAGE_TYPES.sendTestText:
      return sendTestText(request.payload as InternalRequestMap["SEND_TEST_TEXT"]);
    case INTERNAL_MESSAGE_TYPES.webAppPing: {
      const before = await stateStore.load();
      if (!["running", "pausing", "paused"].includes(before.status)) await runPreflight(750);
      const state = await stateStore.load();
      return {
        operational: state.operational,
        message: state.statusMessage,
        extensionVersion: EXTENSION_VERSION,
        configuredLimit: 0,
        sentToday: 0,
        availableToday: 0,
        ...(!state.operational ? { errorCode: state.whatsapp?.status === "login_required" ? "session_not_ready" : "extension_not_ready" } : {})
      };
    }
    case INTERNAL_MESSAGE_TYPES.webAppPrepareCampaign:
      return acceptCampaign(request.payload as SerializedCampaignPayload);
    case INTERNAL_MESSAGE_TYPES.webAppCancelCampaign:
      return cancelCampaign((request.payload as InternalRequestMap["WEB_APP_CANCEL_CAMPAIGN"]).campaignId);
    default:
      throw new ExtensionError(ERROR_CODES.protocolError, "Tipo de mensaje interno no admitido.", { recoverable: false });
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isInternalEnvelope(message) || !senderAllowed(message, sender)) return false;
  void handleRequest(message).then(
    (data) => sendResponse({ ok: true, requestId: message.requestId, data }),
    (error: unknown) => sendResponse({ ok: false, requestId: message.requestId, error: serializeError(error) })
  );
  return true;
});

void initialize();
