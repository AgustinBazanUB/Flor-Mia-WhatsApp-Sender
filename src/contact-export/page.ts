import { downloadContactExportWorkbook } from "./excel-exporter";
import type { ContactExportState } from "./types";
import { INTERNAL_MESSAGE_TYPES, sendRuntimeRequest } from "../shared/protocol";
import type { ExtensionState } from "../shared/state";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Falta el elemento #${id}.`);
  return element as T;
};

const whatsappStatus = byId<HTMLParagraphElement>("whatsapp-status");
const refreshStateButton = byId<HTMLButtonElement>("refresh-state");
const detectButton = byId<HTMLButtonElement>("detect-labels");
const selectAllButton = byId<HTMLButtonElement>("select-all");
const selectNoneButton = byId<HTMLButtonElement>("select-none");
const analyzeButton = byId<HTMLButtonElement>("analyze");
const cancelButton = byId<HTMLButtonElement>("cancel");
const exportButton = byId<HTMLButtonElement>("export-excel");
const resetButton = byId<HTMLButtonElement>("reset-export");
const reportButton = byId<HTMLButtonElement>("codex-report");
const jsonReportButton = byId<HTMLButtonElement>("codex-json");
const labelsContainer = byId<HTMLDivElement>("labels");
const labelCount = byId<HTMLElement>("label-count");
const selectedCount = byId<HTMLElement>("selected-count");
const progressWrap = byId<HTMLDivElement>("progress-wrap");
const progressBar = byId<HTMLSpanElement>("progress-bar");
const progressTrack = progressWrap.querySelector<HTMLElement>("[role='progressbar']")!;
const progressCount = byId<HTMLElement>("progress-count");
const progressPercent = byId<HTMLElement>("progress-percent");
const progressLabel = byId<HTMLElement>("progress-label");
const progressContact = byId<HTMLElement>("progress-contact");
const previewBody = byId<HTMLTableSectionElement>("preview-body");
const previewNote = byId<HTMLParagraphElement>("preview-note");
const analysisStatus = byId<HTMLElement>("analysis-status");
const problemCard = byId<HTMLElement>("problem-card");
const problemList = byId<HTMLUListElement>("problem-list");
const problemCount = byId<HTMLElement>("problem-count");
const diagnosticCard = document.querySelector<HTMLElement>(".diagnostic-card")!;
const uiError = byId<HTMLParagraphElement>("ui-error");

let state: ContactExportState | null = null;
let selectedLabelIds = new Set<string>();
let commandBusy = false;

byId<HTMLElement>("module-version").textContent = chrome.runtime.getManifest().version;

function setError(message = ""): void {
  uiError.textContent = message;
  uiError.hidden = !message;
}

function text(elementId: string, value: unknown): void {
  byId<HTMLElement>(elementId).textContent = String(value ?? "—");
}

function updateSelectedControls(): void {
  const count = selectedLabelIds.size;
  selectedCount.textContent = `${count} seleccionada${count === 1 ? "" : "s"}`;
  const canAnalyze = Boolean(state?.labels.length) && count > 0 && !commandBusy && state?.status !== "analyzing" && state?.status !== "cancelling";
  analyzeButton.disabled = !canAnalyze;
}

function renderLabels(current: ContactExportState): void {
  labelCount.textContent = String(current.labels.length);
  selectAllButton.disabled = current.labels.length === 0 || commandBusy;
  selectNoneButton.disabled = current.labels.length === 0 || commandBusy;
  if (!current.labels.length) {
    labelsContainer.innerHTML = '<p class="empty">Todavía no se detectaron etiquetas.</p>';
    selectedLabelIds.clear();
    updateSelectedControls();
    return;
  }
  const validIds = new Set(current.labels.map((label) => label.id));
  selectedLabelIds = new Set([...selectedLabelIds].filter((id) => validIds.has(id)));
  if (current.selectedLabelIds.length && ["analyzing", "completed", "cancelled", "error"].includes(current.status)) {
    selectedLabelIds = new Set(current.selectedLabelIds.filter((id) => validIds.has(id)));
  }
  labelsContainer.replaceChildren(...current.labels.map((label) => {
    const row = document.createElement("label");
    row.className = "label-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedLabelIds.has(label.id);
    checkbox.disabled = commandBusy || current.status === "analyzing" || current.status === "cancelling";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedLabelIds.add(label.id);
      else selectedLabelIds.delete(label.id);
      updateSelectedControls();
    });
    const name = document.createElement("strong");
    name.textContent = label.name;
    row.append(checkbox, name);
    if (label.countHint != null) {
      const hint = document.createElement("small");
      hint.textContent = `${label.countHint} contactos`;
      row.append(hint);
    }
    return row;
  }));
  updateSelectedControls();
}

function renderProgress(current: ContactExportState): void {
  const progress = current.progress;
  const active = ["analyzing", "cancelling"].includes(current.status);
  progressWrap.hidden = !progress && !active;
  cancelButton.hidden = !active;
  if (!progress) return;
  const percent = progress.percent == null ? null : Math.max(0, Math.min(100, progress.percent));
  progressBar.style.width = `${percent ?? 0}%`;
  progressTrack.setAttribute("aria-valuenow", String(percent ?? 0));
  progressCount.textContent = `${progress.processed} / ${progress.totalHint ?? "?"}`;
  progressPercent.textContent = percent == null ? "Progreso estimado: —" : `${percent} %`;
  progressLabel.textContent = `Etiqueta actual: ${progress.currentLabel ?? "—"}`;
  progressContact.textContent = `Contacto actual: ${progress.currentContact}`;
}

function renderResults(current: ContactExportState): void {
  text("stat-found", current.summary.found);
  text("stat-valid", current.summary.valid);
  text("stat-duplicates", current.summary.duplicatesRemoved);
  text("stat-phone", current.summary.withoutPhone);
  text("stat-name", current.summary.withoutName);
  text("stat-noncontacts", current.summary.excludedNonContacts);
  text("metric-duration", current.metrics ? `${(current.metrics.durationMs / 1000).toFixed(2)} s` : "—");
  text("metric-rate", current.metrics?.contactsPerSecond ?? "—");
  text("metric-scrolls", current.metrics?.scrollOperations ?? "—");
  text("metric-visual", current.metrics?.visualOperations ?? "—");
  text("metric-chats", current.metrics?.chatsOpened ?? "—");

  const statusLabels: Record<string, string> = {
    idle: "Sin analizar",
    detecting_labels: "Detectando etiquetas…",
    ready: "Etiquetas listas",
    analyzing: "Analizando…",
    completed: "Análisis completo",
    cancelling: "Cancelando…",
    cancelled: "Análisis cancelado",
    error: "Necesita revisión"
  };
  analysisStatus.textContent = statusLabels[current.status] ?? current.status;

  if (!current.contacts.length) {
    previewBody.innerHTML = '<tr><td colspan="3" class="empty">No hay contactos válidos para mostrar.</td></tr>';
  } else {
    previewBody.replaceChildren(...current.contacts.slice(0, 25).map((contact) => {
      const row = document.createElement("tr");
      for (const value of [contact.phone, contact.name, contact.zone]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    }));
  }
  previewNote.textContent = current.contacts.length > 25
    ? `Se muestran 25 de ${current.contacts.length} contactos. El Excel incluye todos los válidos.`
    : `Se muestran ${current.contacts.length} contactos. El Excel incluye todos los válidos.`;
  exportButton.disabled = commandBusy || current.status !== "completed" || current.contacts.length === 0;

  problemCount.textContent = String(current.problems.length);
  problemCard.hidden = current.problems.length === 0;
  problemList.replaceChildren(...current.problems.slice(0, 50).map((problem) => {
    const item = document.createElement("li");
    item.textContent = `${problem.labelName}: ${problem.reason}${problem.namePresent ? " · nombre disponible" : " · sin nombre"}`;
    return item;
  }));
}

function renderDiagnostic(current: ContactExportState): void {
  const diagnostic = current.diagnostic;
  diagnosticCard.dataset.status = diagnostic.status;
  const labels = { green: "VERDE · extracción disponible", red: "ROJO · necesita revisión", unknown: "Sin comprobar" };
  text("diagnostic-status", labels[diagnostic.status]);
  text("diagnostic-last", diagnostic.lastSuccessfulStep);
  text("diagnostic-failed", diagnostic.failedStep);
  text("diagnostic-label", diagnostic.labelName);
  text("diagnostic-strategy", diagnostic.strategy);
  text("diagnostic-expected", diagnostic.expectedElement);
  text("diagnostic-reported", diagnostic.reportedCount);
  text("diagnostic-collected", diagnostic.collectedUniqueContacts);
  text("diagnostic-candidates", diagnostic.candidateCount);
}

function render(current: ContactExportState): void {
  state = current;
  commandBusy = ["detecting_labels", "analyzing", "cancelling"].includes(current.status);
  detectButton.disabled = commandBusy;
  resetButton.disabled = commandBusy;
  renderLabels(current);
  renderProgress(current);
  renderResults(current);
  renderDiagnostic(current);
  updateSelectedControls();
}

async function refreshWhatsAppState(): Promise<void> {
  try {
    const extension = await sendRuntimeRequest("contact-export-page", INTERNAL_MESSAGE_TYPES.getState, {}) as ExtensionState;
    const session = extension.whatsapp?.qrDetected ? "WhatsApp Web está abierto, pero necesita iniciar sesión." : extension.operational ? "WhatsApp Web detectado y listo." : extension.statusMessage;
    whatsappStatus.textContent = session || "No se pudo determinar el estado de WhatsApp Web.";
  } catch (error) {
    whatsappStatus.textContent = error instanceof Error ? error.message : "No se pudo consultar WhatsApp Web.";
  }
}

async function refreshExportState(): Promise<void> {
  const current = await sendRuntimeRequest("contact-export-page", INTERNAL_MESSAGE_TYPES.contactExportGetState, {});
  render(current);
}

async function runCommand<T>(operation: () => Promise<T>): Promise<T | null> {
  setError();
  try {
    commandBusy = true;
    updateSelectedControls();
    return await operation();
  } catch (error) {
    setError(error instanceof Error ? error.message : "La operación no pudo completarse.");
    return null;
  } finally {
    commandBusy = false;
    await refreshExportState().catch(() => undefined);
    updateSelectedControls();
  }
}

refreshStateButton.addEventListener("click", () => void Promise.all([refreshWhatsAppState(), refreshExportState()]));
detectButton.addEventListener("click", () => void runCommand(async () => {
  selectedLabelIds.clear();
  const current = await sendRuntimeRequest("contact-export-page", INTERNAL_MESSAGE_TYPES.contactExportDetectLabels, {});
  render(current);
  return current;
}));
selectAllButton.addEventListener("click", () => {
  for (const label of state?.labels ?? []) selectedLabelIds.add(label.id);
  if (state) renderLabels(state);
});
selectNoneButton.addEventListener("click", () => {
  selectedLabelIds.clear();
  if (state) renderLabels(state);
});
analyzeButton.addEventListener("click", () => void runCommand(async () => {
  const current = await sendRuntimeRequest("contact-export-page", INTERNAL_MESSAGE_TYPES.contactExportAnalyze, {
    selectedLabelIds: [...selectedLabelIds]
  });
  render(current);
  return current;
}));
cancelButton.addEventListener("click", () => void runCommand(async () => {
  const current = await sendRuntimeRequest("contact-export-page", INTERNAL_MESSAGE_TYPES.contactExportCancel, {});
  render(current);
  return current;
}));
resetButton.addEventListener("click", () => void runCommand(async () => {
  selectedLabelIds.clear();
  const current = await sendRuntimeRequest("contact-export-page", INTERNAL_MESSAGE_TYPES.contactExportReset, {});
  render(current);
  return current;
}));
exportButton.addEventListener("click", () => {
  if (!state?.contacts.length) return;
  const selectedNames = state.labels.filter((label) => state!.selectedLabelIds.includes(label.id)).map((label) => label.name);
  const filename = downloadContactExportWorkbook({ contacts: state.contacts, selectedLabels: selectedNames, date: new Date() });
  setError("");
  exportButton.textContent = `Exportado: ${filename}`;
  globalThis.setTimeout(() => { exportButton.textContent = "Exportar Excel"; }, 3_000);
});

function downloadDiagnosticFile(filename: string, value: string, type: string): void {
  const blob = new Blob([value], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function getDiagnosticBundle() {
  return sendRuntimeRequest("contact-export-page", INTERNAL_MESSAGE_TYPES.generateDiagnosticReport, { includeCampaignName: false });
}

reportButton.addEventListener("click", () => void runCommand(async () => {
  const bundle = await getDiagnosticBundle();
  const date = new Date().toISOString().slice(0, 10);
  downloadDiagnosticFile(`flormia_contact_export_diagnostic_${date}.txt`, bundle.text, "text/plain;charset=utf-8");
  return bundle;
}));

jsonReportButton.addEventListener("click", () => void runCommand(async () => {
  const bundle = await getDiagnosticBundle();
  const date = new Date().toISOString().slice(0, 10);
  downloadDiagnosticFile(`flormia_contact_export_diagnostic_${date}.json`, bundle.json, "application/json;charset=utf-8");
  return bundle;
}));

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== "session") return;
  void refreshExportState().catch(() => undefined);
});

void Promise.all([refreshWhatsAppState(), refreshExportState()]).catch((error) => setError(error instanceof Error ? error.message : "No se pudo iniciar el módulo."));
