import { isAllowedWebAppOrigin } from "../config/origins";
import { validateCampaignInput } from "../shared/campaign";
import { ERROR_CODES, ExtensionError, serializeError, toExtensionError } from "../shared/errors";
import { createId } from "../shared/ids";
import { logger } from "../shared/logger";
import { normalizePhone } from "../shared/phone";
import { processContact } from "../engine/contact-engine";
import { FaultInjectingContactAdapter, isDevelopmentFault } from "../engine/fault-injection";
import { createContactCheckpoint, markInterruptedCheckpointAmbiguous } from "../engine/steps";
import type { ContactAdapter, ContactProcessCheckpoint } from "../engine/types";
import {
  INTERNAL_MESSAGE_TYPES,
  isInternalEnvelope,
  type InternalEnvelope,
  type InternalRequestMap,
  type InternalResponseMap
} from "../shared/protocol";
import { base64ToArrayBuffer, deserializeCampaign, type SerializedCampaignPayload } from "../shared/serialization";
import type { ExtensionState, TextTestResult, WhatsAppPreflightResult } from "../shared/state";
import { CampaignBlobStore } from "../storage/blob-store";
import { ContactCheckpointStore } from "../storage/checkpoint-store";
import { StateStore } from "../storage/state-store";
import { ChromeWhatsAppContactAdapter } from "./contact-adapter";
import { WhatsAppTransport } from "./whatsapp-transport";
import { CampaignRuntime } from "./campaign-runtime";
import { campaignIdFromAlarm } from "../campaign/scheduler";

const stateStore = new StateStore();
const blobStore = new CampaignBlobStore();
const checkpointStore = new ContactCheckpointStore();
const whatsappTransport = new WhatsAppTransport();
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const campaignRuntime = new CampaignRuntime({
  stateStore,
  blobStore,
  checkpointStore,
  transport: whatsappTransport,
  runPreflight: (timeoutMs) => runPreflight(timeoutMs, true),
  onContactCheckpoint: syncCheckpointState
});

async function initialize(): Promise<void> {
  const campaign = await campaignRuntime.initialize();
  if (campaign) {
    logger.info("service_worker.initialized", {
      version: EXTENSION_VERSION,
      campaignId: campaign.campaignId,
      campaignStatus: campaign.status
    });
    return;
  }
  let state = await stateStore.load();
  const active = await checkpointStore.loadActive();
  if (active) {
    const rehydrated = markInterruptedCheckpointAmbiguous(active);
    await checkpointStore.saveActive(rehydrated);
    const restoredExtensionStatus = rehydrated.status === "completed"
      ? "completed"
      : rehydrated.status === "failed"
        ? "error"
        : "paused";
    const mustPause = restoredExtensionStatus === "paused";
    state = await stateStore.save({
      ...state,
      status: restoredExtensionStatus,
      activeContactProcess: rehydrated,
      currentContact: {
        recipientId: rehydrated.contact.contactId,
        name: rehydrated.contact.name,
        phone: `+${rehydrated.contact.phoneDigits}`,
        maskedPhone: rehydrated.contact.maskedPhone
      },
      currentStep: rehydrated.currentStepId,
      statusMessage: mustPause
        ? "Proceso recuperado. Revisá el checkpoint antes de reanudar."
        : state.statusMessage
    });
  } else {
    state = await stateStore.save({ ...state, activeContactProcess: null });
  }
  logger.info("service_worker.initialized", { version: EXTENSION_VERSION, state: state.status, activeCheckpoint: Boolean(active) });
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
      multimedia: { state: "unavailable", message }
    }
  };
}

async function preparePreflightState(campaignControl = false): Promise<void> {
  const current = await stateStore.load();
  if (!campaignControl && (current.status === "running" || current.status === "pausing" || current.status === "paused")) {
    throw new ExtensionError(ERROR_CODES.internal, "No se puede ejecutar un diagnóstico mientras hay una operación activa.");
  }
  if (campaignControl) return;
  if (current.status === "completed" || current.status === "error") await stateStore.transition("idle");
  await stateStore.transition("preflight", { currentStep: "preflight", operational: false, statusMessage: "Comprobando WhatsApp Web…" });
}

async function runPreflight(timeoutMs = 8_000, campaignControl = false): Promise<WhatsAppPreflightResult> {
  await preparePreflightState(campaignControl);
  const tab = await whatsappTransport.findTab();
  if (!tab?.id) {
    const result = unavailablePreflight("WhatsApp Web no está abierto en ninguna pestaña.");
    if (campaignControl) await stateStore.patch({ whatsapp: result, operational: false, statusMessage: result.message });
    else await stateStore.transition("error", { whatsapp: result, operational: false, statusMessage: result.message, currentStep: null });
    return result;
  }
  try {
    const result = await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappPreflight, { timeoutMs }, tab.id);
    if (campaignControl) {
      await stateStore.patch({ whatsapp: result, operational: result.operational, statusMessage: result.message });
    } else if (result.operational) {
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
    if (campaignControl) await stateStore.patch({ whatsapp: result, operational: false, statusMessage: result.message });
    else await stateStore.transition("error", { whatsapp: result, operational: false, statusMessage: result.message, currentStep: null });
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
    const tab = await whatsappTransport.findTab();
    if (!tab?.id) throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "WhatsApp Web dejó de estar disponible.");

    await stateStore.transition("running", {
      currentContact: { recipientId: operationId, phone: phone.e164, maskedPhone: phone.masked },
      currentStep: "open-conversation",
      lastCheckpoint: { operationId, recipientId: operationId, step: "preflight-complete", createdAt: new Date().toISOString() },
      statusMessage: "Abriendo la conversación de prueba…"
    });
    await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, { operationId, phoneDigits: phone.digits }, tab.id);
    await stateStore.patch({
      currentStep: "wait-conversation",
      lastCheckpoint: { operationId, recipientId: operationId, step: "navigation-requested", createdAt: new Date().toISOString() }
    });
    await whatsappTransport.waitForContent(tab.id, 30_000);
    await stateStore.patch({ currentStep: "send-text", statusMessage: "Enviando y verificando el mensaje de prueba…" });
    const result = await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappSendText, {
      operationId,
      phoneDigits: phone.digits,
      message
    }, tab.id);
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

function statusMessageForCheckpoint(checkpoint: ContactProcessCheckpoint): string {
  if (checkpoint.status === "completed") return "Contacto procesado completamente y verificado.";
  if (checkpoint.status === "images_required") return "Volvé a seleccionar las imágenes de la campaña para continuar.";
  if (checkpoint.pauseReason === "verification_pending") return "Resultado ambiguo: se pausó para evitar un posible envío duplicado.";
  if (checkpoint.pauseReason === "max_attempts") return "Campaña pausada automáticamente al alcanzar el máximo de intentos.";
  if (checkpoint.status === "failed") return "El contacto quedó detenido por un error no recuperable.";
  const step = checkpoint.steps.find((candidate) => candidate.id === checkpoint.currentStepId);
  return step ? `Procesando ${step.kind === "image" ? `imagen ${step.image.order}` : "texto"}…` : "Preparando el contacto…";
}

async function syncCheckpointState(checkpoint: ContactProcessCheckpoint): Promise<void> {
  await stateStore.patch({
    activeContactProcess: checkpoint,
    currentStep: checkpoint.currentStepId,
    currentContact: {
      recipientId: checkpoint.contact.contactId,
      name: checkpoint.contact.name,
      phone: `+${checkpoint.contact.phoneDigits}`,
      maskedPhone: checkpoint.contact.maskedPhone
    },
    lastCheckpoint: {
      operationId: checkpoint.currentStepId
        ? checkpoint.steps.find((step) => step.id === checkpoint.currentStepId)?.operationId ?? checkpoint.checkpointId
        : checkpoint.checkpointId,
      campaignId: checkpoint.campaignId,
      recipientId: checkpoint.contact.contactId,
      step: checkpoint.lastConfirmedStepId ?? checkpoint.currentStepId ?? checkpoint.status,
      createdAt: checkpoint.updatedAt
    },
    statusMessage: statusMessageForCheckpoint(checkpoint)
  });
}

async function finalizeContactState(checkpoint: ContactProcessCheckpoint, startedAt: string): Promise<void> {
  const current = await stateStore.load();
  if (checkpoint.status === "completed") {
    if (current.status === "running") {
      await stateStore.transition("completed", {
        activeContactProcess: checkpoint,
        progress: { total: 1, sent: 1, failed: 0 },
        currentStep: null,
        currentContact: null,
        operational: true,
        statusMessage: statusMessageForCheckpoint(checkpoint)
      });
    } else {
      await stateStore.save({ ...current, status: "completed", activeContactProcess: checkpoint, progress: { total: 1, sent: 1, failed: 0 } });
    }
  } else if (checkpoint.status === "paused" || checkpoint.status === "images_required") {
    if (current.status === "running") {
      await stateStore.transition("pausing", { activeContactProcess: checkpoint });
      await stateStore.transition("paused", {
        activeContactProcess: checkpoint,
        currentStep: checkpoint.currentStepId,
        operational: true,
        statusMessage: statusMessageForCheckpoint(checkpoint)
      });
    } else {
      await stateStore.save({ ...current, status: "paused", activeContactProcess: checkpoint, statusMessage: statusMessageForCheckpoint(checkpoint) });
    }
  } else if (checkpoint.status === "failed") {
    if (current.status === "running") {
      await stateStore.transition("error", {
        activeContactProcess: checkpoint,
        currentStep: checkpoint.currentStepId,
        operational: false,
        statusMessage: statusMessageForCheckpoint(checkpoint)
      });
    } else {
      await stateStore.save({ ...current, status: "error", activeContactProcess: checkpoint, statusMessage: statusMessageForCheckpoint(checkpoint) });
    }
  }
  await stateStore.appendOperation({
    operationId: checkpoint.checkpointId,
    kind: "contact-process",
    success: checkpoint.status === "completed",
    startedAt,
    completedAt: new Date().toISOString(),
    maskedPhone: checkpoint.contact.maskedPhone,
    ...(checkpoint.status !== "completed" ? { errorCode: checkpoint.steps.find((step) => step.id === checkpoint.currentStepId)?.error?.code } : {})
  });
}

async function runContactCheckpoint(
  checkpoint: ContactProcessCheckpoint,
  faultInjection: InternalRequestMap["PROCESS_TEST_CONTACT"]["faultInjection"] = "none"
): Promise<ContactProcessCheckpoint> {
  const baseAdapter = new ChromeWhatsAppContactAdapter(blobStore, whatsappTransport);
  const adapter: ContactAdapter = faultInjection && faultInjection !== "none"
    ? new FaultInjectingContactAdapter(baseAdapter, faultInjection)
    : baseAdapter;
  const state = await stateStore.load();
  return processContact(checkpoint, {
    store: checkpointStore,
    adapter,
    policy: state.config.retryPolicy,
    onCheckpoint: syncCheckpointState
  });
}

async function processTestContact(
  payload: InternalRequestMap["PROCESS_TEST_CONTACT"]
): Promise<ContactProcessCheckpoint> {
  const activeCampaign = await campaignRuntime.campaignStore.loadActive();
  if (activeCampaign && !["completed", "stopped"].includes(activeCampaign.status)) {
    throw new ExtensionError(ERROR_CODES.campaignConflict, "Hay una campaña activa. Pausala o detenela antes de usar la prueba manual.");
  }
  if (activeCampaign) {
    await blobStore.deleteCampaign(activeCampaign.campaignId);
    const campaignCheckpoint = await checkpointStore.loadActive();
    if (campaignCheckpoint?.campaignId === activeCampaign.campaignId) await checkpointStore.clearActive();
    await campaignRuntime.campaignStore.clearActive();
    await stateStore.patch({ activeCampaign: null, currentCampaign: null });
  }
  const phone = normalizePhone(payload.phone);
  if (!isDevelopmentFault(payload.faultInjection ?? "none")) {
    throw new ExtensionError(ERROR_CODES.invalidInput, "La inyección de fallos solicitada no es válida.");
  }
  const existing = await checkpointStore.loadActive();
  if (existing && !["completed", "failed"].includes(existing.status)) {
    throw new ExtensionError(ERROR_CODES.invalidInput, "Ya existe un contacto pausado o en curso. Reanudalo antes de crear otra prueba.");
  }
  if (existing) {
    await blobStore.deleteCampaign(existing.campaignId);
    await checkpointStore.clearActive();
  }

  const preflight = await runPreflight();
  if (!preflight.operational) {
    throw new ExtensionError(preflight.qrDetected ? ERROR_CODES.sessionNotReady : ERROR_CODES.whatsappNotOpen, preflight.message);
  }

  const campaignId = createId("manual-campaign");
  const contactId = createId("manual-contact");
  let images;
  try {
    images = (payload.images ?? []).map((image) => ({ ...image, data: base64ToArrayBuffer(image.dataBase64) }));
  } catch (error) {
    throw new ExtensionError(ERROR_CODES.invalidInput, "Una imagen no contiene datos base64 válidos.", { cause: error });
  }
  const validated = validateCampaignInput({
    campaignId,
    campaignName: "Prueba manual de un contacto",
    createdBy: "extension-popup",
    recipients: [{ recipientId: contactId, name: "Prueba manual", phone: phone.digits, source: "flor_mia" }],
    message: String(payload.message ?? ""),
    imageCount: images.length,
    imageOrder: images.map((image) => image.order),
    images,
    totalRecipients: 1
  });

  await blobStore.putCampaignImages(campaignId, validated.images.map((image) => ({
    imageId: `image-${image.order}`,
    order: image.order,
    name: image.name,
    type: image.type,
    blob: new Blob([image.data], { type: image.type })
  })));

  const checkpoint = createContactCheckpoint({
    campaignId,
    campaignName: validated.campaignName,
    contact: { contactId, name: "Prueba manual", phoneDigits: phone.digits, maskedPhone: phone.masked },
    images: validated.images.map((image) => ({
      imageId: `image-${image.order}`,
      order: image.order,
      name: image.name,
      type: image.type,
      size: image.size
    })),
    text: validated.message
  });
  await checkpointStore.saveActive(checkpoint);
  await stateStore.transition("running", {
    activeContactProcess: checkpoint,
    currentCampaign: {
      campaignId,
      campaignName: validated.campaignName,
      createdBy: validated.createdBy,
      totalRecipients: 1,
      messageLength: validated.message.length,
      imageCount: validated.imageCount,
      receivedAt: checkpoint.createdAt,
      status: "received"
    },
    progress: { total: 1, sent: 0, failed: 0 },
    currentContact: { recipientId: contactId, name: "Prueba manual", phone: phone.e164, maskedPhone: phone.masked },
    currentStep: checkpoint.currentStepId,
    operational: true,
    statusMessage: "Procesando el contacto de prueba…"
  });

  const startedAt = new Date().toISOString();
  const result = await runContactCheckpoint(checkpoint, payload.faultInjection ?? "none");
  await finalizeContactState(result, startedAt);
  return result;
}

async function resumeContactProcess(): Promise<ContactProcessCheckpoint> {
  const checkpoint = await checkpointStore.loadActive();
  if (!checkpoint) throw new ExtensionError(ERROR_CODES.invalidInput, "No existe un contacto para reanudar.");
  if (checkpoint.status === "completed") return checkpoint;
  if (checkpoint.status === "failed") {
    throw new ExtensionError(ERROR_CODES.retryLimit, "El contacto tiene un error no recuperable y no puede reanudarse automáticamente.", {
      recoverable: false
    });
  }
  if (checkpoint.status === "images_required") {
    throw new ExtensionError(ERROR_CODES.imageMissing, "Volvé a seleccionar las imágenes antes de reanudar.");
  }
  const state = await stateStore.load();
  await stateStore.save({
    ...state,
    status: "running",
    activeContactProcess: checkpoint,
    operational: true,
    statusMessage: "Reanudando desde el checkpoint confirmado…"
  });
  const startedAt = new Date().toISOString();
  const result = await runContactCheckpoint(checkpoint);
  await finalizeContactState(result, startedAt);
  return result;
}

async function reselectContactImages(
  payload: InternalRequestMap["RESELECT_CONTACT_IMAGES"]
): Promise<ContactProcessCheckpoint> {
  const checkpoint = await checkpointStore.loadActive();
  if (!checkpoint || checkpoint.campaignId !== payload.campaignId) {
    throw new ExtensionError(ERROR_CODES.invalidInput, "La campaña activa no coincide con las imágenes seleccionadas.");
  }
  const allImages = checkpoint.steps.filter((step) => step.kind === "image").sort((a, b) => a.position - b.position);
  const requiredImages = allImages.filter((step) => step.status === "images_required");
  const requiredOrders = new Set((requiredImages.length ? requiredImages : allImages).map((step) => step.image.order));
  const receivedOrders = new Set(payload.images.map((image) => image.order));
  if (payload.images.length === 0 || [...requiredOrders].some((order) => !receivedOrders.has(order))) {
    throw new ExtensionError(ERROR_CODES.invalidInput, "Seleccioná nuevamente cada imagen que figura como faltante.");
  }
  const restored = payload.images.map((image) => {
    const step = allImages.find((candidate) => candidate.image.order === image.order);
    if (!step) throw new ExtensionError(ERROR_CODES.invalidInput, `La imagen con orden ${image.order} no pertenece a esta campaña.`);
    let data: ArrayBuffer;
    try {
      data = base64ToArrayBuffer(image.dataBase64);
    } catch (error) {
      throw new ExtensionError(ERROR_CODES.invalidInput, `La imagen ${image.order} no contiene datos válidos.`, { cause: error });
    }
    if (image.name !== step.image.name || image.type !== step.image.type || image.size !== step.image.size || data.byteLength !== step.image.size) {
      throw new ExtensionError(ERROR_CODES.invalidInput, `La imagen ${image.order} no coincide con el archivo original.`);
    }
    return {
      imageId: step.image.imageId,
      order: step.image.order,
      name: step.image.name,
      type: step.image.type,
      blob: new Blob([data], { type: step.image.type })
    };
  });
  await blobStore.putCampaignImages(checkpoint.campaignId, restored);
  const next: ContactProcessCheckpoint = {
    ...checkpoint,
    status: "paused",
    pauseReason: undefined,
    steps: checkpoint.steps.map((step) => step.kind === "image" && step.status === "images_required" && receivedOrders.has(step.image.order)
      ? { ...step, status: "pending", error: undefined }
      : step),
    updatedAt: new Date().toISOString()
  };
  await checkpointStore.saveActive(next);
  await stateStore.patch({ activeContactProcess: next, statusMessage: "Imágenes restauradas. Ya podés reanudar desde el checkpoint." });
  return next;
}

async function recordOperationStage(
  payload: InternalRequestMap["WA_OPERATION_STAGE"]
): Promise<InternalResponseMap["WA_OPERATION_STAGE"]> {
  const checkpoint = await checkpointStore.loadActive();
  if (!checkpoint) return { recorded: false };
  const step = checkpoint.steps.find((candidate) => candidate.operationId === payload.operationId);
  if (!step || step.status !== "in_progress" || payload.stage !== "send_attempted") return { recorded: false };
  const observedAt = new Date().toISOString();
  const next: ContactProcessCheckpoint = {
    ...checkpoint,
    steps: checkpoint.steps.map((candidate) => candidate.operationId === payload.operationId
      ? {
          ...candidate,
          verification: {
            outcome: "ambiguous",
            method: "send-attempted-checkpoint",
            observedAt,
            sendAttempted: true,
            baselineOutgoingIds: payload.baselineOutgoingIds
              .filter((item) => typeof item === "string")
              .slice(-200)
          }
        }
      : candidate),
    updatedAt: observedAt
  };
  await checkpointStore.saveActive(next);
  await syncCheckpointState(next);
  return { recorded: true };
}

async function acceptCampaign(payload: SerializedCampaignPayload): Promise<InternalResponseMap["WEB_APP_PREPARE_CAMPAIGN"]> {
  const campaign = validateCampaignInput(deserializeCampaign(payload));
  const acceptedAt = new Date().toISOString();
  await campaignRuntime.prepare(campaign);
  await stateStore.appendOperation({
    operationId: createId("campaign"), kind: "campaign-received", success: true, startedAt: acceptedAt, completedAt: acceptedAt
  });
  return { campaignId: campaign.campaignId, acceptedAt };
}

async function cancelCampaign(campaignId: string): Promise<InternalResponseMap["WEB_APP_CANCEL_CAMPAIGN"]> {
  if (!campaignId.trim()) throw new ExtensionError(ERROR_CODES.invalidInput, "campaignId es obligatorio.");
  await campaignRuntime.stop(campaignId);
  return { campaignId, cancelledAt: new Date().toISOString() };
}

async function loadCurrentExtensionState(): Promise<ExtensionState> {
  let state = await stateStore.load();
  let campaign = await campaignRuntime.campaignStore.loadActive();
  const dailyLimit = await campaignRuntime.dailyLimit.load(
    campaign?.policy.dailyContactLimit ?? state.config.campaignPolicy.dailyContactLimit,
    new Date()
  );
  if (campaign && (
    campaign.dailyLimit.localDate !== dailyLimit.localDate
    || campaign.dailyLimit.completedToday !== dailyLimit.completedToday
    || campaign.dailyLimit.limit !== dailyLimit.limit
  )) {
    campaign = await campaignRuntime.campaignStore.saveActive({
      ...campaign,
      dailyLimit,
      sequence: campaign.sequence + 1,
      updatedAt: new Date().toISOString()
    });
    await campaignRuntime.syncCampaign(campaign);
    state = await stateStore.load();
  } else if (
    state.dailyLimit.localDate !== dailyLimit.localDate
    || state.dailyLimit.completedToday !== dailyLimit.completedToday
    || state.dailyLimit.limit !== dailyLimit.limit
  ) {
    state = await stateStore.patch({ dailyLimit });
  }
  return {
    ...state,
    activeCampaign: campaign,
    dailyLimit,
    activeContactProcess: await checkpointStore.loadActive()
  };
}

function senderAllowed(request: InternalEnvelope, sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (request.source === "popup") return sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/popup/`) === true;
  if (request.source === "whatsapp-content") return sender.url?.startsWith("https://web.whatsapp.com/") === true;
  if (request.source === "web-app-bridge") {
    try { return Boolean(sender.url && isAllowedWebAppOrigin(new URL(sender.url).origin)); } catch { return false; }
  }
  return false;
}

async function handleRequest(request: InternalEnvelope): Promise<unknown> {
  switch (request.type) {
    case INTERNAL_MESSAGE_TYPES.getState:
      return loadCurrentExtensionState();
    case INTERNAL_MESSAGE_TYPES.runPreflight:
      return runPreflight();
    case INTERNAL_MESSAGE_TYPES.sendTestText:
      return sendTestText(request.payload as InternalRequestMap["SEND_TEST_TEXT"]);
    case INTERNAL_MESSAGE_TYPES.processTestContact:
      return processTestContact(request.payload as InternalRequestMap["PROCESS_TEST_CONTACT"]);
    case INTERNAL_MESSAGE_TYPES.resumeContactProcess:
      return resumeContactProcess();
    case INTERNAL_MESSAGE_TYPES.reselectContactImages:
      return reselectContactImages(request.payload as InternalRequestMap["RESELECT_CONTACT_IMAGES"]);
    case INTERNAL_MESSAGE_TYPES.campaignStart:
      return campaignRuntime.start((request.payload as InternalRequestMap["CAMPAIGN_START"]).campaignId);
    case INTERNAL_MESSAGE_TYPES.campaignPause:
      return campaignRuntime.pause((request.payload as InternalRequestMap["CAMPAIGN_PAUSE"]).campaignId);
    case INTERNAL_MESSAGE_TYPES.campaignResume:
      return campaignRuntime.resume((request.payload as InternalRequestMap["CAMPAIGN_RESUME"]).campaignId);
    case INTERNAL_MESSAGE_TYPES.campaignStop:
      return campaignRuntime.stop((request.payload as InternalRequestMap["CAMPAIGN_STOP"]).campaignId);
    case INTERNAL_MESSAGE_TYPES.campaignStatus:
      return campaignRuntime.getStatus((request.payload as InternalRequestMap["CAMPAIGN_STATUS"]).campaignId);
    case INTERNAL_MESSAGE_TYPES.campaignRestoreImages: {
      const payload = request.payload as InternalRequestMap["CAMPAIGN_RESTORE_IMAGES"];
      return campaignRuntime.restoreImages(payload.campaignId, payload.images);
    }
    case INTERNAL_MESSAGE_TYPES.whatsappOperationStage:
      return recordOperationStage(request.payload as InternalRequestMap["WA_OPERATION_STAGE"]);
    case INTERNAL_MESSAGE_TYPES.webAppPing: {
      const before = await loadCurrentExtensionState();
      if (!["running", "pausing", "paused"].includes(before.status)) await runPreflight(750, Boolean(before.activeCampaign));
      const state = await loadCurrentExtensionState();
      return {
        operational: state.operational,
        message: state.statusMessage,
        extensionVersion: EXTENSION_VERSION,
        configuredLimit: state.dailyLimit.limit,
        sentToday: state.dailyLimit.completedToday,
        availableToday: state.dailyLimit.remaining,
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

chrome.alarms.onAlarm.addListener((alarm) => {
  const campaignId = campaignIdFromAlarm(alarm.name);
  if (!campaignId) return;
  void campaignRuntime.handleAlarm(campaignId).catch(async (error: unknown) => {
    const normalized = toExtensionError(error);
    await stateStore.appendError({ ...serializeError(normalized), at: new Date().toISOString() });
    logger.error("campaign.alarm_failed", { campaignId, errorCode: normalized.code });
  });
});

void initialize();
