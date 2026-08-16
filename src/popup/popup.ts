import type { DevelopmentFault } from "../engine/fault-injection";
import type { ContactProcessCheckpoint, ContactStep } from "../engine/types";
import { INTERNAL_MESSAGE_TYPES, sendRuntimeRequest } from "../shared/protocol";
import { arrayBufferToBase64, type SerializedCampaignImage } from "../shared/serialization";
import type { ExtensionState, TextTestResult, WhatsAppPreflightResult } from "../shared/state";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Falta el elemento #${id}`);
  return found as T;
}

const extensionStatus = element("extension-status");
const statusMessage = element("status-message");
const whatsappPage = element("whatsapp-page");
const whatsappSession = element("whatsapp-session");
const whatsappInterface = element("whatsapp-interface");
const whatsappMultimedia = element("whatsapp-multimedia");
const diagnosticButton = element<HTMLButtonElement>("diagnostic-button");
const form = element<HTMLFormElement>("test-form");
const phoneInput = element<HTMLInputElement>("phone");
const messageInput = element<HTMLTextAreaElement>("message");
const imagesInput = element<HTMLInputElement>("images");
const imageCount = element("image-count");
const faultInjection = element<HTMLSelectElement>("fault-injection");
const sendButton = element<HTMLButtonElement>("send-button");
const lastResult = element("last-result");
const characterCount = element("character-count");
const uiError = element("ui-error");
const processSummary = element("process-summary");
const processSteps = element<HTMLUListElement>("process-steps");
const processAlert = element("process-alert");
const resumeButton = element<HTMLButtonElement>("resume-button");
const reselectForm = element<HTMLFormElement>("reselect-form");
const reselectImages = element<HTMLInputElement>("reselect-images");
const reselectButton = element<HTMLButtonElement>("reselect-button");
const campaignName = element("campaign-name");
const campaignStatus = element("campaign-status");
const campaignProgressText = element("campaign-progress-text");
const campaignDailyLimit = element("campaign-daily-limit");
const campaignProgressBar = element<HTMLElement>("campaign-progress-bar");
const campaignCurrentContact = element("campaign-current-contact");
const campaignCurrentStep = element("campaign-current-step");
const campaignAlert = element("campaign-alert");
const campaignStart = element<HTMLButtonElement>("campaign-start");
const campaignPause = element<HTMLButtonElement>("campaign-pause");
const campaignResume = element<HTMLButtonElement>("campaign-resume");
const campaignStop = element<HTMLButtonElement>("campaign-stop");

let currentState: ExtensionState | null = null;

function setBusy(button: HTMLButtonElement, busy: boolean, busyText: string, normalText: string): void {
  button.disabled = busy;
  button.textContent = busy ? busyText : normalText;
}

function renderPreflight(preflight: WhatsAppPreflightResult | null, operational: boolean, message: string): void {
  extensionStatus.classList.toggle("is-operational", operational);
  extensionStatus.innerHTML = `<span class="status-dot ${operational ? "is-operational" : "is-error"}"></span>${operational ? "Operativa" : "Error / requiere revisión"}`;
  statusMessage.textContent = message;
  whatsappPage.textContent = preflight ? (preflight.pageDetected ? "Abierto" : "No abierto") : "Sin comprobar";
  whatsappSession.textContent = preflight ? (preflight.sessionReady ? "Iniciada" : preflight.qrDetected ? "Requiere QR" : "No preparada") : "Sin comprobar";
  whatsappInterface.textContent = preflight ? (preflight.mainInterfaceReady ? "Disponible" : "Cargando") : "Sin comprobar";
  whatsappMultimedia.textContent = preflight
    ? preflight.capabilities.multimedia.state === "available" ? "Disponible" : "Al abrir chat"
    : "Sin comprobar";
}

function renderResult(result: TextTestResult | null): void {
  if (!result) {
    lastResult.className = "empty-result";
    lastResult.textContent = "Todavía no se ejecutó la prueba heredada de texto.";
    return;
  }
  const completed = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(result.completedAt));
  lastResult.className = "result";
  lastResult.replaceChildren();
  const title = document.createElement("strong");
  title.className = result.success ? "is-success" : "is-error";
  title.textContent = result.success ? "Mensaje saliente verificado" : "Prueba no confirmada";
  const metadata = document.createElement("span");
  metadata.textContent = `${result.maskedPhone || "Número no registrado"} · ${completed}`;
  const detail = document.createElement("span");
  detail.textContent = result.success ? `Método: ${result.verification.method}` : result.error?.message || "Sin confirmación verificable.";
  lastResult.append(title, metadata, detail);
}

function stepLabel(step: ContactStep): string {
  return step.kind === "image" ? `Imagen ${step.image.order}` : "Texto";
}

function stepStatus(step: ContactStep): string {
  const labels: Record<ContactStep["status"], string> = {
    pending: "Pendiente",
    in_progress: "En curso",
    verification_pending: "Verificación pendiente",
    confirmed: "Confirmado",
    failed: "Falló",
    images_required: "Requiere archivo"
  };
  return labels[step.status];
}

function renderProcess(checkpoint: ContactProcessCheckpoint | null, managedByCampaign: boolean): void {
  processSteps.replaceChildren();
  processAlert.hidden = true;
  processAlert.textContent = "";
  resumeButton.hidden = true;
  reselectForm.hidden = true;
  if (!checkpoint) {
    processSummary.textContent = "Todavía no hay un contacto procesado por el motor del Prompt 2.";
    return;
  }
  processSummary.textContent = `${checkpoint.contact.maskedPhone} · ${checkpoint.status.replaceAll("_", " ")} · checkpoint ${checkpoint.lastConfirmedStepId ?? "inicial"}`;
  for (const step of checkpoint.steps) {
    const item = document.createElement("li");
    item.className = `process-step is-${step.status}`;
    const title = document.createElement("strong");
    title.textContent = stepLabel(step);
    const status = document.createElement("span");
    status.textContent = `${stepStatus(step)} · ${step.attempts} intento${step.attempts === 1 ? "" : "s"}`;
    item.append(title, status);
    if (step.error?.message) {
      const error = document.createElement("small");
      error.textContent = step.error.message;
      item.append(error);
    }
    processSteps.append(item);
  }
  if (checkpoint.status === "paused") {
    resumeButton.hidden = managedByCampaign;
    resumeButton.textContent = checkpoint.pauseReason === "verification_pending"
      ? "Reconciliar y reanudar"
      : "Reanudar desde checkpoint";
    processAlert.hidden = false;
    processAlert.textContent = checkpoint.pauseReason === "verification_pending"
      ? "Resultado ambiguo: la próxima reanudación reconciliará el DOM antes de repetir."
      : "Campaña pausada automáticamente. Revisá el paso y reanudá cuando corresponda.";
  }
  if (checkpoint.status === "images_required") {
    processAlert.hidden = false;
    processAlert.textContent = "Volvé a seleccionar las imágenes originales de la campaña.";
    reselectForm.hidden = false;
  }
  if (checkpoint.status === "failed") {
    processAlert.hidden = false;
    processAlert.textContent = "El contacto se detuvo por un error no recuperable. Revisá el paso y el error técnico antes de iniciar otra prueba.";
  }
}

function campaignStatusLabel(status: NonNullable<ExtensionState["activeCampaign"]>["status"]): string {
  const labels: Record<NonNullable<ExtensionState["activeCampaign"]>["status"], string> = {
    received: "Recibida",
    ready: "Preparada",
    running: "En ejecución",
    pause_requested: "Pausando",
    paused: "Pausada",
    waiting_contact: "Espera contacto",
    waiting_batch: "Espera tanda",
    daily_limit_reached: "Límite diario",
    images_required: "Requiere imágenes",
    error: "Error",
    stopped: "Detenida",
    completed: "Completada"
  };
  return labels[status];
}

function renderCampaign(state: ExtensionState): void {
  const campaign = state.activeCampaign;
  campaignAlert.hidden = true;
  campaignAlert.textContent = "";
  if (!campaign) {
    campaignName.textContent = "Sin campaña recibida";
    campaignStatus.textContent = "—";
    campaignStatus.className = "campaign-status";
    campaignProgressText.textContent = "0 / 0 · 0 %";
    campaignDailyLimit.textContent = `Hoy: ${state.dailyLimit.completedToday} / ${state.dailyLimit.limit}`;
    campaignProgressBar.style.width = "0%";
    campaignProgressBar.parentElement?.setAttribute("aria-valuenow", "0");
    campaignCurrentContact.textContent = "Sin contacto activo";
    campaignCurrentStep.textContent = "Esperando campaña";
    campaignStart.disabled = true;
    campaignPause.disabled = true;
    campaignResume.disabled = true;
    campaignStop.disabled = true;
    return;
  }
  const completed = campaign.completedRecipients;
  const total = campaign.recipients.length;
  const percentage = total ? Number(((completed / total) * 100).toFixed(2)) : 0;
  campaignName.textContent = campaign.campaignName;
  campaignStatus.textContent = campaignStatusLabel(campaign.status);
  campaignStatus.className = `campaign-status is-${campaign.status}`;
  campaignProgressText.textContent = `${completed} / ${total} · ${percentage} %`;
  campaignDailyLimit.textContent = `Hoy: ${campaign.dailyLimit.completedToday} / ${campaign.dailyLimit.limit}`;
  campaignProgressBar.style.width = `${percentage}%`;
  campaignProgressBar.parentElement?.setAttribute("aria-valuenow", String(percentage));

  const active = campaign.activeContactId
    ? campaign.recipients.find((recipient) => recipient.recipientId === campaign.activeContactId)
    : campaign.recipients.find((recipient) => recipient.status === "pending");
  campaignCurrentContact.textContent = active
    ? `Contacto ${active.position} / ${total}${active.name ? ` · ${active.name}` : ""} · ${active.maskedPhone}`
    : "Sin contacto pendiente";
  const checkpoint = state.activeContactProcess?.campaignId === campaign.campaignId ? state.activeContactProcess : null;
  campaignCurrentStep.textContent = checkpoint?.currentStepId
    ? checkpoint.currentStepId.replace("image-", "Imagen ").replace("text", "Texto")
    : campaign.wait?.kind === "between_batches"
      ? "Esperando pausa entre tandas"
      : campaign.wait?.kind === "between_contacts"
        ? "Esperando pausa entre contactos"
        : campaign.status === "received"
          ? "Esperando inicio manual"
          : campaignStatusLabel(campaign.status);
  if (campaign.blockReason) {
    campaignAlert.hidden = false;
    campaignAlert.textContent = campaign.blockReason.message;
  }

  const terminal = campaign.status === "completed" || campaign.status === "stopped";
  campaignStart.disabled = !["received", "ready"].includes(campaign.status);
  campaignPause.disabled = !["running", "waiting_contact", "waiting_batch"].includes(campaign.status);
  campaignResume.disabled = !["paused", "daily_limit_reached"].includes(campaign.status);
  campaignStop.disabled = terminal;
}

function renderState(state: ExtensionState): void {
  currentState = state;
  renderPreflight(state.whatsapp, state.operational, state.statusMessage);
  renderCampaign(state);
  renderResult(state.lastTestResult);
  const managedByCampaign = Boolean(state.activeCampaign
    && state.activeContactProcess?.campaignId === state.activeCampaign.campaignId
    && !["completed", "stopped"].includes(state.activeCampaign.status));
  renderProcess(state.activeContactProcess, managedByCampaign);
}

function showError(error: unknown): void {
  uiError.hidden = false;
  uiError.textContent = error instanceof Error ? error.message : "Ocurrió un error inesperado.";
}

function clearError(): void {
  uiError.hidden = true;
  uiError.textContent = "";
}

async function refreshState(): Promise<void> {
  renderState(await sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.getState, {}));
}

async function serializeFiles(files: File[]): Promise<SerializedCampaignImage[]> {
  if (files.length > 3) throw new Error("Seleccioná como máximo tres imágenes.");
  return Promise.all(files.map(async (file, index) => {
    if (!file.type.startsWith("image/")) throw new Error(`${file.name} no es una imagen.`);
    const data = await file.arrayBuffer();
    return { order: index + 1, name: file.name, type: file.type, size: file.size, dataBase64: arrayBufferToBase64(data) };
  }));
}

async function serializeReselectedFiles(
  files: File[],
  checkpoint: ContactProcessCheckpoint
): Promise<SerializedCampaignImage[]> {
  if (files.length === 0) throw new Error("Seleccioná al menos una imagen faltante.");
  const availableSteps = checkpoint.steps.filter((step) => step.kind === "image");
  const usedOrders = new Set<number>();
  return Promise.all(files.map(async (file) => {
    const matchingStep = availableSteps.find((step) => !usedOrders.has(step.image.order)
      && step.image.name === file.name
      && step.image.type === file.type
      && step.image.size === file.size);
    if (!matchingStep) throw new Error(`${file.name} no coincide con una imagen original de esta campaña.`);
    usedOrders.add(matchingStep.image.order);
    return {
      order: matchingStep.image.order,
      name: file.name,
      type: file.type,
      size: file.size,
      dataBase64: arrayBufferToBase64(await file.arrayBuffer())
    };
  }));
}

async function restoreSelectedImages(
  checkpoint: ContactProcessCheckpoint,
  images: SerializedCampaignImage[]
): Promise<void> {
  if (currentState?.activeCampaign?.campaignId === checkpoint.campaignId) {
    await sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.campaignRestoreImages, { campaignId: checkpoint.campaignId, images });
  } else {
    await sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.reselectContactImages, { campaignId: checkpoint.campaignId, images });
  }
}

diagnosticButton.addEventListener("click", () => {
  clearError();
  setBusy(diagnosticButton, true, "Diagnosticando…", "Ejecutar diagnóstico");
  void sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.runPreflight, {})
    .then(() => refreshState()).catch(showError)
    .finally(() => setBusy(diagnosticButton, false, "Diagnosticando…", "Ejecutar diagnóstico"));
});

messageInput.addEventListener("input", () => {
  characterCount.textContent = `${messageInput.value.length} / 4096`;
});

imagesInput.addEventListener("change", () => {
  const count = imagesInput.files?.length ?? 0;
  imageCount.textContent = `${count} / 3 imágenes`;
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  clearError();
  if (!form.reportValidity()) return;
  const files = [...(imagesInput.files ?? [])];
  if (!messageInput.value.trim() && files.length === 0) {
    showError(new Error("Ingresá texto o seleccioná al menos una imagen."));
    return;
  }
  setBusy(sendButton, true, "Procesando y verificando…", "Procesar contacto de prueba");
  void serializeFiles(files)
    .then((images) => sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.processTestContact, {
      phone: phoneInput.value,
      message: messageInput.value,
      images,
      faultInjection: faultInjection.value as DevelopmentFault
    }))
    .then(() => refreshState())
    .catch(showError)
    .finally(() => setBusy(sendButton, false, "Procesando y verificando…", "Procesar contacto de prueba"));
});

resumeButton.addEventListener("click", () => {
  clearError();
  const normalText = currentState?.activeContactProcess?.pauseReason === "verification_pending"
    ? "Reconciliar y reanudar"
    : "Reanudar desde checkpoint";
  setBusy(resumeButton, true, "Reanudando…", normalText);
  void sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.resumeContactProcess, {})
    .then(() => refreshState())
    .catch(showError)
    .finally(() => setBusy(resumeButton, false, "Reanudando…", normalText));
});

reselectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearError();
  const checkpoint = currentState?.activeContactProcess;
  if (!checkpoint) return showError(new Error("No hay una campaña activa."));
  setBusy(reselectButton, true, "Restaurando…", "Restaurar imágenes");
  void serializeReselectedFiles([...(reselectImages.files ?? [])], checkpoint)
    .then((images) => restoreSelectedImages(checkpoint, images))
    .then(() => refreshState())
    .catch(showError)
    .finally(() => setBusy(reselectButton, false, "Restaurando…", "Restaurar imágenes"));
});

function activeCampaignId(): string {
  const campaignId = currentState?.activeCampaign?.campaignId;
  if (!campaignId) throw new Error("No hay una campaña activa.");
  return campaignId;
}

campaignStart.addEventListener("click", () => {
  clearError();
  setBusy(campaignStart, true, "Iniciando…", "Iniciar");
  void sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.campaignStart, { campaignId: activeCampaignId() })
    .then(() => refreshState()).catch(showError)
    .finally(() => setBusy(campaignStart, false, "Iniciando…", "Iniciar"));
});

campaignPause.addEventListener("click", () => {
  clearError();
  setBusy(campaignPause, true, "Pausando…", "Pausar");
  void sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.campaignPause, { campaignId: activeCampaignId() })
    .then(() => refreshState()).catch(showError)
    .finally(() => setBusy(campaignPause, false, "Pausando…", "Pausar"));
});

campaignResume.addEventListener("click", () => {
  clearError();
  setBusy(campaignResume, true, "Reanudando…", "Reanudar");
  void sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.campaignResume, { campaignId: activeCampaignId() })
    .then(() => refreshState()).catch(showError)
    .finally(() => setBusy(campaignResume, false, "Reanudando…", "Reanudar"));
});

campaignStop.addEventListener("click", () => {
  if (!window.confirm("¿Detener esta campaña? No se procesarán más contactos.")) return;
  clearError();
  setBusy(campaignStop, true, "Deteniendo…", "Detener");
  void sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.campaignStop, { campaignId: activeCampaignId() })
    .then(() => refreshState()).catch(showError)
    .finally(() => setBusy(campaignStop, false, "Deteniendo…", "Detener"));
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === "local") void refreshState().catch(showError);
});

void refreshState().catch(showError);
