import { copyDiagnosticText } from "./clipboard";
import type { DiagnosticReportBundle } from "./types";
import { INTERNAL_MESSAGE_TYPES, sendRuntimeRequest } from "../shared/protocol";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Falta el elemento #${id}`);
  return found as T;
}

const status = element("report-status");
const summary = element("incident-summary");
const summaryCategory = element("summary-category");
const summaryCapability = element("summary-capability");
const summaryStep = element("summary-step");
const summaryContact = element("summary-contact");
const includeCampaignName = element<HTMLInputElement>("include-campaign-name");
const tabText = element<HTMLButtonElement>("tab-text");
const tabJson = element<HTMLButtonElement>("tab-json");
const panelText = element("panel-text");
const panelJson = element("panel-json");
const reportText = element("report-text");
const reportJson = element("report-json");
const copyText = element<HTMLButtonElement>("copy-text");
const copyJson = element<HTMLButtonElement>("copy-json");
const errorBox = element("report-error");
const feedback = element("copy-feedback");
let bundle: DiagnosticReportBundle | null = null;

function setTab(tab: "text" | "json"): void {
  const textActive = tab === "text";
  tabText.classList.toggle("is-active", textActive);
  tabJson.classList.toggle("is-active", !textActive);
  tabText.setAttribute("aria-selected", String(textActive));
  tabJson.setAttribute("aria-selected", String(!textActive));
  panelText.hidden = !textActive;
  panelJson.hidden = textActive;
}

function render(result: DiagnosticReportBundle): void {
  bundle = result;
  reportText.textContent = result.text;
  reportJson.textContent = result.json;
  summaryCategory.textContent = result.report.incident.errorCategory;
  summaryCapability.textContent = result.report.incident.capability ?? "no disponible";
  summaryStep.textContent = result.report.incident.stepId ?? "no disponible";
  summaryContact.textContent = result.report.incident.recipientPosition && result.report.incident.totalRecipients
    ? `${result.report.incident.recipientPosition} / ${result.report.incident.totalRecipients} · ${result.report.incident.maskedPhone ?? "sin teléfono"}`
    : result.report.incident.maskedPhone ?? "no disponible";
  summary.hidden = false;
  status.textContent = "Reporte listo";
  status.className = "status is-ready";
  errorBox.hidden = true;
}

async function loadReport(): Promise<void> {
  status.textContent = "Generando…";
  status.className = "status";
  errorBox.hidden = true;
  try {
    render(await sendRuntimeRequest("diagnostics-page", INTERNAL_MESSAGE_TYPES.generateDiagnosticReport, {
      includeCampaignName: includeCampaignName.checked
    }));
  } catch (error) {
    status.textContent = "No disponible";
    status.className = "status is-error";
    errorBox.hidden = false;
    errorBox.textContent = error instanceof Error ? error.message : "No se pudo generar el reporte.";
  }
}

async function copy(value: string | undefined, label: string): Promise<void> {
  feedback.textContent = "";
  try {
    await copyDiagnosticText(value ?? "");
    feedback.textContent = `${label} copiado al portapapeles.`;
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : "No se pudo copiar.";
  }
}

tabText.addEventListener("click", () => setTab("text"));
tabJson.addEventListener("click", () => setTab("json"));
copyText.addEventListener("click", () => void copy(bundle?.text, "Texto"));
copyJson.addEventListener("click", () => void copy(bundle?.json, "JSON"));
includeCampaignName.addEventListener("change", () => void loadReport());

void loadReport();
