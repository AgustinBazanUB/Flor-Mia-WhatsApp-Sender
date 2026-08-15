import { INTERNAL_MESSAGE_TYPES, sendRuntimeRequest } from "../shared/protocol";
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
const diagnosticButton = element<HTMLButtonElement>("diagnostic-button");
const form = element<HTMLFormElement>("test-form");
const phoneInput = element<HTMLInputElement>("phone");
const messageInput = element<HTMLTextAreaElement>("message");
const sendButton = element<HTMLButtonElement>("send-button");
const lastResult = element("last-result");
const characterCount = element("character-count");
const uiError = element("ui-error");

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
}

function renderResult(result: TextTestResult | null): void {
  if (!result) {
    lastResult.className = "empty-result";
    lastResult.textContent = "Todavía no se ejecutó ninguna prueba.";
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
  detail.textContent = result.success
    ? `Método: ${result.verification.method}`
    : result.error?.message || "No se obtuvo una confirmación verificable.";
  lastResult.append(title, metadata, detail);
}

function renderState(state: ExtensionState): void {
  renderPreflight(state.whatsapp, state.operational, state.statusMessage);
  renderResult(state.lastTestResult);
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
  const state = await sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.getState, {});
  renderState(state);
}

diagnosticButton.addEventListener("click", () => {
  clearError();
  setBusy(diagnosticButton, true, "Diagnosticando…", "Ejecutar diagnóstico");
  void sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.runPreflight, {})
    .then((result) => renderPreflight(result, result.operational, result.message))
    .catch(showError)
    .finally(() => setBusy(diagnosticButton, false, "Diagnosticando…", "Ejecutar diagnóstico"));
});

messageInput.addEventListener("input", () => {
  characterCount.textContent = `${messageInput.value.length} / 4096`;
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  clearError();
  if (!form.reportValidity()) return;
  setBusy(sendButton, true, "Enviando y verificando…", "Enviar mensaje de prueba");
  void sendRuntimeRequest("popup", INTERNAL_MESSAGE_TYPES.sendTestText, {
    phone: phoneInput.value,
    message: messageInput.value
  }).then((result) => {
    renderResult(result);
    if (!result.success) showError(new Error(result.error?.message || "La prueba no pudo verificarse."));
    return refreshState();
  }).catch(showError).finally(() => setBusy(sendButton, false, "Enviando y verificando…", "Enviar mensaje de prueba"));
});

void refreshState().catch(showError);
