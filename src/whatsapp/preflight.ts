import { DEFAULT_PREFLIGHT_REQUIREMENTS, requiredCapabilities } from "../compatibility/requirements";
import type {
  CapabilityDiscovery,
  CapabilityState,
  PreflightProbeImage,
  WhatsAppCapability,
  WhatsAppPreflightRequest
} from "../compatibility/types";
import type { WhatsAppPreflightResult } from "../shared/state";
import {
  canonicalMessageText,
  findAttachButton,
  findComposer,
  findImageFileInput,
  findMediaPreviewCloseButton,
  findQrCode,
  resolveCapability,
  type CapabilityResolverOptions
} from "./selectors";
import { waitForCondition, waitForDocumentReady } from "./wait";

const ALL_CAPABILITIES: WhatsAppCapability[] = [
  "whatsapp_page",
  "content_script",
  "document_ready",
  "session",
  "main_interface",
  "open_conversation",
  "composer",
  "attachment_action",
  "image_file_input",
  "media_preview",
  "media_send_action",
  "text_send_action",
  "outgoing_text_evidence",
  "outgoing_media_evidence"
];

function syntheticDiscovery(
  capability: WhatsAppCapability,
  state: CapabilityState,
  required: boolean,
  logicalStep: string,
  expectedSemanticElement: string,
  message: string,
  strategyId?: string,
  tagName = "document"
): CapabilityDiscovery {
  return {
    capability,
    logicalStep,
    state,
    required,
    message,
    expectedSemanticElement,
    ...(strategyId ? { selectedStrategy: strategyId } : {}),
    attempts: strategyId ? [{
      strategyId,
      method: "semantic-attribute",
      priority: 1,
      result: state === "available" ? "matched" : "not_found",
      matchedCount: state === "available" ? 1 : 0,
      candidates: []
    }] : [],
    candidateCount: 0,
    candidateSummaries: [],
    ...(state === "available" && strategyId ? {
      fingerprint: {
        strategyId,
        method: "semantic-attribute",
        tagName,
        attributes: {},
        semanticFingerprint: `${tagName}|${strategyId}`
      }
    } : {}),
    change: "unknown"
  };
}

function resolverOptions(
  capability: WhatsAppCapability,
  required: boolean,
  request: WhatsAppPreflightRequest
): CapabilityResolverOptions {
  return {
    required,
    disablePrimary: request.developmentFault === "primary_strategy_unavailable",
    forceUnavailable: (request.developmentFault === "attachment_capability_break" && capability === "attachment_action")
      || (request.developmentFault === "main_interface_capability_break" && capability === "main_interface")
  };
}

function markContextRequired(discovery: CapabilityDiscovery, message: string): CapabilityDiscovery {
  return { ...discovery, state: "requires_context", message };
}

function dispatchComposerInput(composer: HTMLElement, data: string | null): void {
  const event = typeof InputEvent === "function"
    ? new InputEvent("input", { bubbles: true, inputType: data ? "insertText" : "deleteContentBackward", data })
    : new Event("input", { bubbles: true });
  composer.dispatchEvent(event);
}

async function discoverTextSendAction(
  composer: HTMLElement | null,
  required: boolean,
  request: WhatsAppPreflightRequest
): Promise<CapabilityDiscovery> {
  const options = resolverOptions("text_send_action", required, request);
  const initial = resolveCapability("text_send_action", document, options).discovery;
  if (!required || initial.state === "available" || !composer || request.level === "lightweight") {
    return initial.state === "unavailable" && !composer
      ? markContextRequired(initial, "La acción de texto requiere una conversación abierta.")
      : initial;
  }
  if (canonicalMessageText(composer.textContent ?? "")) {
    return markContextRequired(initial, "No se modificó el borrador existente para ejecutar el diagnóstico.");
  }
  const originalChildren = [...composer.childNodes];
  try {
    composer.replaceChildren(document.createTextNode("Diagnóstico Flor Mía"));
    dispatchComposerInput(composer, "Diagnóstico Flor Mía");
    return await waitForCondition(
      () => resolveCapability("text_send_action", document, options).match,
      { timeoutMs: Math.min(request.timeoutMs ?? 8_000, 2_000), description: "la acción de texto sin accionar envío" }
    ).then(() => resolveCapability("text_send_action", document, options).discovery).catch(() => initial);
  } finally {
    composer.replaceChildren(...originalChildren);
    dispatchComposerInput(composer, null);
  }
}

function setProbeImage(input: HTMLInputElement, probe: PreflightProbeImage): boolean {
  if (typeof DataTransfer !== "function") return false;
  try {
    const binary = atob(probe.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.byteLength !== probe.size) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], probe.name, { type: probe.type, lastModified: Date.now() }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.files?.item(0)?.size === probe.size;
  } catch {
    return false;
  }
}

function clearProbeInput(input: HTMLInputElement): void {
  input.value = "";
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function dismissProbePreview(preview: HTMLElement, input: HTMLInputElement): Promise<boolean> {
  const close = findMediaPreviewCloseButton(preview) ?? findMediaPreviewCloseButton();
  close?.element.click();
  if (!close) clearProbeInput(input);
  const closed = await waitForCondition(
    () => !preview.isConnected || preview.hidden || preview.getAttribute("aria-hidden") === "true",
    { timeoutMs: 2_000, description: "el cierre seguro del preview de diagnóstico" }
  ).then(() => true).catch(() => false);
  clearProbeInput(input);
  return closed;
}

async function discoverMediaContext(
  required: Set<WhatsAppCapability>,
  request: WhatsAppPreflightRequest,
  discoveries: Partial<Record<WhatsAppCapability, CapabilityDiscovery>>
): Promise<void> {
  const previewOptions = resolverOptions("media_preview", required.has("media_preview"), request);
  const sendOptions = resolverOptions("media_send_action", required.has("media_send_action"), request);
  let previewResolution = resolveCapability("media_preview", document, previewOptions);
  if (previewResolution.match) {
    discoveries.media_preview = previewResolution.discovery;
    discoveries.media_send_action = resolveCapability("media_send_action", previewResolution.match.element, sendOptions).discovery;
    return;
  }
  const requiresFullMediaProbe = required.has("image_file_input")
    || required.has("media_preview")
    || required.has("media_send_action");
  if (!requiresFullMediaProbe || !request.probeImage || request.level !== "full") {
    discoveries.media_preview = markContextRequired(previewResolution.discovery, "Se necesita un preview real para verificar esta capability sin enviar.");
    const send = resolveCapability("media_send_action", document, sendOptions).discovery;
    discoveries.media_send_action = markContextRequired(send, "La acción multimedia solamente se verifica dentro de un preview real.");
    return;
  }

  let inputResolution = resolveCapability<HTMLInputElement>(
    "image_file_input",
    document,
    resolverOptions("image_file_input", required.has("image_file_input"), request)
  );
  const existingInput = inputResolution.match;
  const attach = findAttachButton();
  attach?.element.click();
  const fileInput = existingInput ?? await waitForCondition(
    () => findImageFileInput(),
    { timeoutMs: Math.min(request.timeoutMs ?? 8_000, 3_000), description: "el input de imagen para diagnóstico" }
  ).catch(() => null);
  inputResolution = resolveCapability<HTMLInputElement>(
    "image_file_input",
    document,
    resolverOptions("image_file_input", required.has("image_file_input"), request)
  );
  discoveries.image_file_input = inputResolution.discovery;
  if (!fileInput || !setProbeImage(fileInput.element, request.probeImage)) {
    if (fileInput) clearProbeInput(fileInput.element);
    attach?.element.click();
    discoveries.media_preview = { ...previewResolution.discovery, message: "No fue posible preparar un preview técnico sin enviar contenido." };
    discoveries.media_send_action = markContextRequired(
      resolveCapability("media_send_action", document, sendOptions).discovery,
      "La acción multimedia no pudo verificarse porque el preview técnico no estuvo disponible."
    );
    return;
  }

  previewResolution = await waitForCondition(
    () => resolveCapability("media_preview", document, previewOptions).match,
    { timeoutMs: Math.min(request.timeoutMs ?? 8_000, 5_000), description: "el preview técnico sin envío" }
  ).then(() => resolveCapability("media_preview", document, previewOptions)).catch(() => previewResolution);
  if (!previewResolution.match) {
    clearProbeInput(fileInput.element);
    attach?.element.click();
    discoveries.media_preview = previewResolution.discovery;
    discoveries.media_send_action = markContextRequired(
      resolveCapability("media_send_action", document, sendOptions).discovery,
      "El preview no apareció; la acción multimedia no se probó."
    );
    return;
  }
  const send = resolveCapability("media_send_action", previewResolution.match.element, sendOptions).discovery;
  const safelyDismissed = await dismissProbePreview(previewResolution.match.element, fileInput.element);
  discoveries.media_preview = safelyDismissed
    ? previewResolution.discovery
    : { ...previewResolution.discovery, state: "unavailable", message: "El preview se detectó, pero no pudo cerrarse de forma segura." };
  discoveries.media_send_action = safelyDismissed
    ? send
    : { ...send, state: "unavailable", message: "La prueba multimedia no pudo restaurar la interfaz con seguridad." };
}

export async function runWhatsAppPreflight(
  input: number | WhatsAppPreflightRequest = 8_000
): Promise<WhatsAppPreflightResult> {
  const request: WhatsAppPreflightRequest = typeof input === "number" ? { timeoutMs: input } : input;
  const timeoutMs = request.timeoutMs ?? 8_000;
  const checkedAt = new Date().toISOString();
  const level = request.level ?? "full";
  const requirements = request.requirements ?? DEFAULT_PREFLIGHT_REQUIREMENTS;
  const required = requiredCapabilities(requirements, level);
  const pageDetected = window.location.origin === "https://web.whatsapp.com";
  let documentReady = document.readyState === "interactive" || document.readyState === "complete";
  if (pageDetected && !documentReady) {
    try {
      await waitForDocumentReady(timeoutMs);
      documentReady = true;
    } catch {
      documentReady = false;
    }
  }

  if (pageDetected && documentReady && !findQrCode() && !resolveCapability("main_interface").match && !findComposer()) {
    await waitForCondition(
      () => findQrCode() || resolveCapability("main_interface").match || findComposer(),
      { timeoutMs, description: "la pantalla de acceso o la interfaz principal de WhatsApp" }
    ).catch(() => null);
  }

  const qr = findQrCode();
  const main = resolveCapability("main_interface", document, resolverOptions("main_interface", required.has("main_interface"), request));
  const composer = resolveCapability("composer", document, resolverOptions("composer", required.has("composer"), request));
  const qrDetected = Boolean(qr);
  const mainInterfaceReady = Boolean(main.match || composer.match);
  const sessionReady = mainInterfaceReady && !qrDetected;
  const discoveries: Partial<Record<WhatsAppCapability, CapabilityDiscovery>> = {
    whatsapp_page: syntheticDiscovery("whatsapp_page", pageDetected ? "available" : "unavailable", required.has("whatsapp_page"), "preflight.page", "origen web.whatsapp.com", pageDetected ? "WhatsApp Web detectado." : "Esta página no es WhatsApp Web.", pageDetected ? "origin.web-whatsapp" : undefined, "window"),
    content_script: syntheticDiscovery("content_script", "available", required.has("content_script"), "preflight.content_script", "Content Script conectado", "El Content Script respondió al Service Worker.", "runtime.content-script-response", "script"),
    document_ready: syntheticDiscovery("document_ready", documentReady ? "available" : "unavailable", required.has("document_ready"), "preflight.document_ready", "document readyState interactive/complete", documentReady ? "El documento terminó de cargar." : "El documento todavía está cargando.", documentReady ? "document.ready-state" : undefined),
    session: syntheticDiscovery("session", sessionReady ? "available" : "unavailable", required.has("session"), "preflight.session", "sesión autenticada sin QR", sessionReady ? "La sesión está iniciada." : qrDetected ? "WhatsApp requiere inicio de sesión manual." : "La sesión todavía no puede confirmarse.", sessionReady ? "session.main-interface-without-qr" : undefined),
    main_interface: main.discovery,
    open_conversation: syntheticDiscovery("open_conversation", sessionReady ? "available" : "unavailable", required.has("open_conversation"), "conversation.open", "navegación segura /send sin envío", sessionReady ? "La navegación a un destinatario explícito está disponible." : "Se necesita una sesión iniciada.", sessionReady ? "navigation.send-url" : undefined, "location"),
    composer: composer.match ? composer.discovery : markContextRequired(composer.discovery, "El composer requiere una conversación abierta."),
    attachment_action: resolveCapability("attachment_action", document, resolverOptions("attachment_action", required.has("attachment_action"), request)).discovery,
    image_file_input: resolveCapability("image_file_input", document, resolverOptions("image_file_input", required.has("image_file_input"), request)).discovery,
    outgoing_text_evidence: resolveCapability("outgoing_text_evidence", document, resolverOptions("outgoing_text_evidence", required.has("outgoing_text_evidence"), request)).discovery,
    outgoing_media_evidence: resolveCapability("outgoing_media_evidence", document, resolverOptions("outgoing_media_evidence", required.has("outgoing_media_evidence"), request)).discovery
  };

  if (!composer.match) {
    for (const capability of ["attachment_action", "image_file_input", "outgoing_text_evidence", "outgoing_media_evidence"] as const) {
      if (discoveries[capability]?.state === "unavailable") {
        discoveries[capability] = markContextRequired(discoveries[capability]!, "Esta capability requiere una conversación abierta.");
      }
    }
  }
  discoveries.text_send_action = await discoverTextSendAction(composer.match?.element ?? null, required.has("text_send_action"), request);
  await discoverMediaContext(required, request, discoveries);

  for (const capability of ALL_CAPABILITIES) {
    if (discoveries[capability]) continue;
    discoveries[capability] = syntheticDiscovery(
      capability,
      "not_tested",
      required.has(capability),
      `preflight.${capability}`,
      capability,
      "Capability no evaluada en este nivel de preflight."
    );
  }

  const capabilities = discoveries as Record<WhatsAppCapability, CapabilityDiscovery>;
  const criticalFailures = [...required].filter((capability) => capabilities[capability].state !== "available");
  const overallStatus: WhatsAppPreflightResult["overallStatus"] = criticalFailures.length === 0 ? "GREEN" : "RED";
  let status: WhatsAppPreflightResult["status"] = overallStatus === "GREEN" ? "ready" : "incompatible";
  let message = overallStatus === "GREEN"
    ? "Todas las capabilities críticas para esta campaña están disponibles."
    : "WhatsApp Web no es compatible actualmente con una o más funciones necesarias.";
  if (!pageDetected) {
    status = "unavailable";
    message = "WhatsApp Web no está abierto en esta página.";
  } else if (!documentReady) {
    status = "loading";
    message = "WhatsApp Web todavía está cargando; no se clasificó como cambio de interfaz.";
  } else if (qrDetected) {
    status = "login_required";
    message = "WhatsApp Web requiere iniciar sesión manualmente.";
  }

  return {
    checkedAt,
    pageDetected,
    contentScriptConnected: true,
    documentReady,
    sessionReady,
    mainInterfaceReady,
    qrDetected,
    operational: overallStatus === "GREEN",
    overallStatus,
    level,
    requirements,
    status,
    message,
    capabilities,
    strategiesUsed: Object.values(capabilities)
      .map((capability) => capability.selectedStrategy)
      .filter((strategy): strategy is string => Boolean(strategy)),
    failures: []
  };
}
