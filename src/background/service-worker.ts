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
import type { CampaignPublicStatus, CampaignState } from "../campaign/campaign-types";
import { CompatibilityStore } from "../storage/compatibility-store";
import { CompatibilityManager, applyRuntimeFailureToPreflight } from "../compatibility/manager";
import { createUnavailablePreflight } from "../compatibility/preflight-result";
import {
  isCompatibilityDevelopmentFault,
  type WhatsAppPreflightRequest
} from "../compatibility/types";
import { TechnicalTraceStore } from "../storage/technical-trace-store";
import { technicalTraceFromCheckpoint } from "../diagnostics/trace-from-checkpoint";
import { createDiagnosticIncident } from "../diagnostics/incident";
import { buildDiagnosticEnvironment } from "../diagnostics/environment";
import { createDiagnosticReportBundle } from "../diagnostics/report-builder";
import { classifyDiagnosticError } from "../diagnostics/taxonomy";

const stateStore = new StateStore();
const blobStore = new CampaignBlobStore();
const checkpointStore = new ContactCheckpointStore();
const whatsappTransport = new WhatsAppTransport();
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const compatibilityStore = new CompatibilityStore();
const compatibilityManager = new CompatibilityManager(compatibilityStore, EXTENSION_VERSION);
const technicalTraceStore = new TechnicalTraceStore();
const campaignRuntime = new CampaignRuntime({
  stateStore,
  blobStore,
  checkpointStore,
  transport: whatsappTransport,
  runPreflight: (request) => runPreflight(request, true),
  onContactCheckpoint: syncCheckpointState
});

async function initialize(): Promise<void> {
  await stateStore.patch({ compatibility: await compatibilityStore.load() });
  const campaign = await campaignRuntime.initialize();
  if (campaign) {
    const checkpoint = await checkpointStore.loadActive();
    await stateStore.patch({
      serviceWorkerRecovery: {
        recoveredAt: new Date().toISOString(),
        campaignId: campaign.campaignId,
        campaignStatus: campaign.status,
        checkpointPresent: Boolean(checkpoint),
        checkpointStatus: checkpoint?.status ?? null
      }
    });
    await refreshDiagnosticIncident();
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
        : state.statusMessage,
      serviceWorkerRecovery: {
        recoveredAt: new Date().toISOString(),
        campaignId: rehydrated.campaignId,
        campaignStatus: null,
        checkpointPresent: true,
        checkpointStatus: rehydrated.status
      }
    });
  } else {
    state = await stateStore.save({
      ...state,
      activeContactProcess: null,
      serviceWorkerRecovery: {
        recoveredAt: new Date().toISOString(),
        campaignId: null,
        campaignStatus: null,
        checkpointPresent: false,
        checkpointStatus: null
      }
    });
  }
  await refreshDiagnosticIncident();
  logger.info("service_worker.initialized", { version: EXTENSION_VERSION, state: state.status, activeCheckpoint: Boolean(active) });
}

chrome.runtime.onInstalled.addListener(() => void initialize());
chrome.runtime.onStartup.addListener(() => void initialize());

async function preparePreflightState(campaignControl = false): Promise<void> {
  const current = await stateStore.load();
  if (!campaignControl && (current.status === "running" || current.status === "pausing" || current.status === "paused")) {
    throw new ExtensionError(ERROR_CODES.internal, "No se puede ejecutar un diagnóstico mientras hay una operación activa.");
  }
  if (campaignControl) return;
  if (current.status === "completed" || current.status === "error") await stateStore.transition("idle");
  await stateStore.transition("preflight", { currentStep: "preflight", operational: false, statusMessage: "Comprobando WhatsApp Web…" });
}

async function recordPreflightTrace(
  result: WhatsAppPreflightResult,
  request: WhatsAppPreflightRequest,
  startedAt: string
): Promise<void> {
  const state = await stateStore.load();
  const failure = result.failures[0] ?? null;
  const errorCode = result.operational
    ? null
    : result.qrDetected
      ? ERROR_CODES.sessionNotReady
      : !result.pageDetected
        ? ERROR_CODES.whatsappNotOpen
        : result.status === "loading"
          ? ERROR_CODES.interfaceLoading
          : ERROR_CODES.preflightFailed;
  const completedAt = new Date().toISOString();
  await technicalTraceStore.append({
    timestampStart: startedAt,
    timestampEnd: completedAt,
    campaignId: state.activeCampaign?.campaignId ?? "extension",
    contactId: state.activeContactProcess?.contact.contactId ?? null,
    stepId: null,
    attempt: null,
    action: `preflight_${request.level ?? "full"}`,
    outcome: result.operational ? "green" : result.status,
    errorCode,
    errorCategory: errorCode
      ? classifyDiagnosticError({ code: errorCode }, { online: navigator.onLine })
      : null,
    verificationMethod: null,
    capability: failure?.capability ?? null,
    strategy: failure?.lastKnownWorkingStrategy ?? null,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
  });
}

async function runPreflight(
  input: number | WhatsAppPreflightRequest = {},
  campaignControl = false
): Promise<WhatsAppPreflightResult> {
  const traceStartedAt = new Date().toISOString();
  let request: WhatsAppPreflightRequest = typeof input === "number" ? { timeoutMs: input } : input;
  if (request.level === "lightweight" && (!request.developmentFault || request.developmentFault === "none")) {
    const developmentFault = await compatibilityStore.consumeHealthCheckFault();
    if (developmentFault !== "none") request = { ...request, developmentFault };
  }
  await preparePreflightState(campaignControl);
  const tab = await whatsappTransport.findTab();
  if (!tab?.id) {
    const evaluated = await compatibilityManager.evaluate(createUnavailablePreflight("WhatsApp Web no está abierto en ninguna pestaña.", request));
    if (campaignControl) await stateStore.patch({ whatsapp: evaluated.preflight, compatibility: evaluated.state, operational: false, statusMessage: evaluated.preflight.message });
    else await stateStore.transition("error", { whatsapp: evaluated.preflight, compatibility: evaluated.state, operational: false, statusMessage: evaluated.preflight.message, currentStep: null });
    await recordPreflightTrace(evaluated.preflight, request, traceStartedAt);
    return evaluated.preflight;
  }
  try {
    const raw = await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappPreflight, request, tab.id);
    const { preflight: result, state: compatibility } = await compatibilityManager.evaluate(raw);
    if (campaignControl) {
      await stateStore.patch({ whatsapp: result, compatibility, operational: result.operational, statusMessage: result.message });
    } else if (result.operational) {
      await stateStore.transition("ready", { whatsapp: result, compatibility, operational: true, statusMessage: result.message, currentStep: null });
    } else {
      await stateStore.transition("error", { whatsapp: result, compatibility, operational: false, statusMessage: result.message, currentStep: null });
    }
    await stateStore.appendOperation({
      operationId: createId("diagnostic"), kind: "diagnostic", success: result.operational,
      startedAt: result.checkedAt, completedAt: new Date().toISOString()
    });
    await recordPreflightTrace(result, request, traceStartedAt);
    return result;
  } catch (error) {
    const normalized = toExtensionError(error, ERROR_CODES.interfaceLoading);
    const raw = createUnavailablePreflight(normalized.message, request, {
      pageDetected: true,
      contentScriptConnected: false,
      status: "loading"
    });
    const { preflight: result, state: compatibility } = await compatibilityManager.evaluate(raw);
    if (campaignControl) await stateStore.patch({ whatsapp: result, compatibility, operational: false, statusMessage: result.message });
    else await stateStore.transition("error", { whatsapp: result, compatibility, operational: false, statusMessage: result.message, currentStep: null });
    await stateStore.appendError({ ...serializeError(normalized), at: new Date().toISOString() });
    await recordPreflightTrace(result, request, traceStartedAt);
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
  let updatedState = await stateStore.patch({
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
  await technicalTraceStore.appendMany(technicalTraceFromCheckpoint(checkpoint, updatedState.compatibility));
  const currentStepError = checkpoint.steps.find((step) => step.id === checkpoint.currentStepId)?.error;
  const currentStep = checkpoint.steps.find((step) => step.id === checkpoint.currentStepId);
  const lastConfirmedStep = checkpoint.steps.find((step) => step.id === checkpoint.lastConfirmedStepId);
  const technicalError = checkpoint.error ?? currentStepError;
  if (technicalError) {
    const compatibilityFailure = await compatibilityManager.recordRuntimeFailure(technicalError, {
      campaignId: checkpoint.campaignId,
      maskedContact: checkpoint.contact.maskedPhone,
      ...(checkpoint.currentStepId ? { stepId: checkpoint.currentStepId } : {}),
      ...(currentStep ? { attempts: currentStep.attempts } : {}),
      lastSuccessfulCapability: lastConfirmedStep
        ? lastConfirmedStep.kind === "image" ? "outgoing_media_evidence" : "outgoing_text_evidence"
        : "open_conversation"
    });
    if (compatibilityFailure) {
      updatedState = await stateStore.patch({
        compatibility: compatibilityFailure.state,
        operational: false,
        whatsapp: updatedState.whatsapp
          ? applyRuntimeFailureToPreflight(updatedState.whatsapp, compatibilityFailure.failure)
          : updatedState.whatsapp,
        statusMessage: "WhatsApp Web no es compatible actualmente con una o más funciones necesarias."
      });
    }
  }
  await refreshDiagnosticIncident(updatedState);
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
  await runCampaignControl("campaign_stop", campaignId, () => campaignRuntime.stop(campaignId));
  return { campaignId, cancelledAt: new Date().toISOString() };
}

async function runCampaignControl(
  action: "campaign_start" | "campaign_pause" | "campaign_resume" | "campaign_stop",
  campaignId: string,
  operation: () => Promise<CampaignPublicStatus>
): Promise<CampaignPublicStatus> {
  const timestampStart = new Date().toISOString();
  try {
    const result = await operation();
    const timestampEnd = new Date().toISOString();
    await technicalTraceStore.append({
      timestampStart,
      timestampEnd,
      campaignId,
      contactId: null,
      stepId: null,
      attempt: null,
      action,
      outcome: result.status,
      errorCode: null,
      errorCategory: action === "campaign_pause" ? "USER_PAUSE" : action === "campaign_stop" ? "USER_STOP" : null,
      verificationMethod: "campaign-state-transition",
      capability: null,
      strategy: null,
      durationMs: Math.max(0, Date.parse(timestampEnd) - Date.parse(timestampStart))
    });
    return result;
  } catch (error) {
    const normalized = serializeError(error);
    const timestampEnd = new Date().toISOString();
    await technicalTraceStore.append({
      timestampStart,
      timestampEnd,
      campaignId,
      contactId: null,
      stepId: null,
      attempt: null,
      action,
      outcome: "failed",
      errorCode: normalized.code,
      errorCategory: classifyDiagnosticError(normalized),
      verificationMethod: "campaign-state-transition",
      capability: null,
      strategy: null,
      durationMs: Math.max(0, Date.parse(timestampEnd) - Date.parse(timestampStart))
    });
    throw error;
  }
}

async function refreshDiagnosticIncident(
  providedState?: ExtensionState,
  providedCampaign?: CampaignState | null,
  providedCheckpoint?: ContactProcessCheckpoint | null
): Promise<ExtensionState> {
  const state = providedState ?? await stateStore.load();
  const campaign = providedCampaign === undefined ? await campaignRuntime.campaignStore.loadActive() : providedCampaign;
  const checkpoint = providedCheckpoint === undefined ? await checkpointStore.loadActive() : providedCheckpoint;
  const incident = createDiagnosticIncident({
    state: { ...state, activeCampaign: campaign, activeContactProcess: checkpoint },
    campaign,
    checkpoint,
    compatibility: state.compatibility,
    online: navigator.onLine,
    includeCampaignName: false
  });
  if (JSON.stringify(state.diagnosticIncident) === JSON.stringify(incident)) {
    return { ...state, activeCampaign: campaign, activeContactProcess: checkpoint };
  }
  const saved = await stateStore.patch({ diagnosticIncident: incident });
  return { ...saved, activeCampaign: campaign, activeContactProcess: checkpoint };
}

async function generateDiagnosticReport(
  payload: InternalRequestMap["GENERATE_DIAGNOSTIC_REPORT"]
): Promise<InternalResponseMap["GENERATE_DIAGNOSTIC_REPORT"]> {
  const state = await loadCurrentExtensionState();
  const campaign = await campaignRuntime.campaignStore.loadActive();
  const checkpoint = await checkpointStore.loadActive();
  const incident = createDiagnosticIncident({
    state,
    campaign,
    checkpoint,
    compatibility: state.compatibility,
    online: navigator.onLine,
    includeCampaignName: payload.includeCampaignName ?? false
  });
  if (!incident) {
    throw new ExtensionError(ERROR_CODES.invalidInput, "No existe un incidente técnico para generar el reporte.");
  }
  const generatedAt = new Date().toISOString();
  await technicalTraceStore.append({
    timestampStart: generatedAt,
    timestampEnd: generatedAt,
    campaignId: incident.campaignId ?? "extension",
    contactId: incident.recipientInternalId,
    stepId: incident.stepId,
    attempt: incident.attempts,
    action: "generate_codex_report",
    outcome: "generated",
    errorCode: null,
    errorCategory: null,
    verificationMethod: null,
    capability: incident.capability,
    strategy: null,
    durationMs: 0
  });
  const tab = await whatsappTransport.findTab();
  const trace = incident.campaignId
    ? await technicalTraceStore.listCampaign(incident.campaignId, 200)
    : await technicalTraceStore.listRecent(200);
  return createDiagnosticReportBundle({
    generatedAt,
    extensionVersion: EXTENSION_VERSION,
    manifestVersion: chrome.runtime.getManifest().manifest_version,
    environment: buildDiagnosticEnvironment({
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      whatsappUrl: tab?.url ?? null,
      preflight: state.whatsapp,
      now: new Date(generatedAt)
    }),
    incident,
    state,
    campaign,
    checkpoint,
    compatibility: state.compatibility,
    trace,
    serviceWorkerRecovery: state.serviceWorkerRecovery,
    includeCampaignName: payload.includeCampaignName ?? false
  });
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
  const checkpoint = await checkpointStore.loadActive();
  return refreshDiagnosticIncident({
    ...state,
    activeCampaign: campaign,
    dailyLimit,
    activeContactProcess: checkpoint
  }, campaign, checkpoint);
}

function senderAllowed(request: InternalEnvelope, sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (request.source === "popup") return sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/popup/`) === true;
  if (request.source === "diagnostics-page") return sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/diagnostics/`) === true;
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
    case INTERNAL_MESSAGE_TYPES.runPreflight: {
      const payload = request.payload as InternalRequestMap["RUN_WHATSAPP_PREFLIGHT"];
      if (payload.developmentFault && !isCompatibilityDevelopmentFault(payload.developmentFault)) {
        throw new ExtensionError(ERROR_CODES.invalidInput, "El escenario de compatibilidad no es válido.");
      }
      const state = await stateStore.load();
      const campaign = state.activeCampaign;
      const forceImageDiagnostic = payload.developmentFault === "attachment_capability_break";
      if (campaign && ["received", "ready", "paused", "daily_limit_reached", "images_required"].includes(campaign.status)) {
        return campaignRuntime.runCampaignPreflight(campaign.campaignId, payload.developmentFault ?? "none");
      }
      return runPreflight({
        level: "full",
        requirements: campaign
          ? { needsText: Boolean(campaign.text.trim()), needsImages: campaign.images.length > 0 }
          : { needsText: false, needsImages: forceImageDiagnostic },
        developmentFault: payload.developmentFault ?? "none"
      });
    }
    case INTERNAL_MESSAGE_TYPES.setCompatibilityDevelopmentFault: {
      const fault = (request.payload as InternalRequestMap["SET_COMPATIBILITY_DEVELOPMENT_FAULT"]).fault;
      if (!isCompatibilityDevelopmentFault(fault)) {
        throw new ExtensionError(ERROR_CODES.invalidInput, "El escenario de compatibilidad no es válido.");
      }
      const compatibility = await compatibilityStore.setDevelopmentFault(fault);
      await stateStore.patch({ compatibility });
      return compatibility;
    }
    case INTERNAL_MESSAGE_TYPES.generateDiagnosticReport:
      return generateDiagnosticReport(request.payload as InternalRequestMap["GENERATE_DIAGNOSTIC_REPORT"]);
    case INTERNAL_MESSAGE_TYPES.sendTestText:
      return sendTestText(request.payload as InternalRequestMap["SEND_TEST_TEXT"]);
    case INTERNAL_MESSAGE_TYPES.processTestContact:
      return processTestContact(request.payload as InternalRequestMap["PROCESS_TEST_CONTACT"]);
    case INTERNAL_MESSAGE_TYPES.resumeContactProcess:
      return resumeContactProcess();
    case INTERNAL_MESSAGE_TYPES.reselectContactImages:
      return reselectContactImages(request.payload as InternalRequestMap["RESELECT_CONTACT_IMAGES"]);
    case INTERNAL_MESSAGE_TYPES.campaignStart:
      return runCampaignControl("campaign_start", (request.payload as InternalRequestMap["CAMPAIGN_START"]).campaignId, () =>
        campaignRuntime.start((request.payload as InternalRequestMap["CAMPAIGN_START"]).campaignId));
    case INTERNAL_MESSAGE_TYPES.campaignPause:
      return runCampaignControl("campaign_pause", (request.payload as InternalRequestMap["CAMPAIGN_PAUSE"]).campaignId, () =>
        campaignRuntime.pause((request.payload as InternalRequestMap["CAMPAIGN_PAUSE"]).campaignId));
    case INTERNAL_MESSAGE_TYPES.campaignResume:
      return runCampaignControl("campaign_resume", (request.payload as InternalRequestMap["CAMPAIGN_RESUME"]).campaignId, () =>
        campaignRuntime.resume((request.payload as InternalRequestMap["CAMPAIGN_RESUME"]).campaignId));
    case INTERNAL_MESSAGE_TYPES.campaignStop:
      return runCampaignControl("campaign_stop", (request.payload as InternalRequestMap["CAMPAIGN_STOP"]).campaignId, () =>
        campaignRuntime.stop((request.payload as InternalRequestMap["CAMPAIGN_STOP"]).campaignId));
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
