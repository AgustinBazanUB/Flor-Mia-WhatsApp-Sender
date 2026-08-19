import { DEFAULT_PREFLIGHT_REQUIREMENTS, requiredCapabilities } from "../compatibility/requirements";
import type {
  CapabilityDiscovery,
  CapabilityState,
  WhatsAppCapability,
  WhatsAppPreflightRequest
} from "../compatibility/types";
import type { WhatsAppPreflightResult } from "../shared/state";
import {
  findComposer,
  findQrCode,
  resolveCapability,
  type CapabilityResolverOptions
} from "./selectors";
import { waitForCondition, waitForDocumentReady, type DocumentReadySignal } from "./wait";

export const CONTENT_INSTANCE_ID = globalThis.crypto?.randomUUID?.() ?? `wa-content-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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

const CONVERSATION_CAPABILITIES = ALL_CAPABILITIES.filter((capability) => ![
  "whatsapp_page", "content_script", "document_ready", "session", "main_interface", "open_conversation"
].includes(capability));

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

function notTested(capability: WhatsAppCapability, required: boolean): CapabilityDiscovery {
  return syntheticDiscovery(
    capability,
    "not_tested",
    required,
    `preflight.${capability}`,
    capability.replaceAll("_", " "),
    "No se inspecciona durante un preflight automático. Se valida en la operación real o en diagnóstico manual."
  );
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

function hasSemanticWhatsAppSurface(): boolean {
  return Boolean(findQrCode() || resolveCapability("main_interface").match || findComposer());
}

function inspectConversationCapabilities(
  request: WhatsAppPreflightRequest,
  required: Set<WhatsAppCapability>,
  discoveries: Partial<Record<WhatsAppCapability, CapabilityDiscovery>>
): void {
  const composer = resolveCapability("composer", document, resolverOptions("composer", required.has("composer"), request));
  discoveries.composer = composer.match
    ? composer.discovery
    : markContextRequired(composer.discovery, "El composer requiere una conversación abierta; el diagnóstico no abrirá ni modificará una conversación para forzarlo.");

  for (const capability of ["attachment_action", "image_file_input", "outgoing_text_evidence", "outgoing_media_evidence"] as const) {
    const resolution = resolveCapability(capability, document, resolverOptions(capability, required.has(capability), request)).discovery;
    discoveries[capability] = resolution.state === "available" || !required.has(capability)
      ? resolution
      : markContextRequired(resolution, "Esta capability requiere contexto real y se valida durante la operación correspondiente.");
  }

  const textSend = resolveCapability("text_send_action", document, resolverOptions("text_send_action", required.has("text_send_action"), request)).discovery;
  discoveries.text_send_action = textSend.state === "available" || !required.has("text_send_action")
    ? textSend
    : markContextRequired(textSend, "La acción Send se valida después de escribir el contenido real; el diagnóstico nunca escribe texto sintético.");

  const preview = resolveCapability("media_preview", document, resolverOptions("media_preview", required.has("media_preview"), request));
  discoveries.media_preview = preview.match
    ? preview.discovery
    : markContextRequired(preview.discovery, "El preview sólo se valida con una imagen real; el diagnóstico no adjunta archivos técnicos.");
  const mediaSend = preview.match
    ? resolveCapability("media_send_action", preview.match.element, resolverOptions("media_send_action", required.has("media_send_action"), request)).discovery
    : resolveCapability("media_send_action", document, resolverOptions("media_send_action", required.has("media_send_action"), request)).discovery;
  discoveries.media_send_action = mediaSend.state === "available" || !required.has("media_send_action")
    ? mediaSend
    : markContextRequired(mediaSend, "La acción Send multimedia requiere un preview real y no se fuerza durante diagnóstico.");
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
  if (request.targetedCapability) required.add(request.targetedCapability);
  const inspectConversation = level === "targeted" || request.purpose === "manual_diagnostic";
  const pageDetected = window.location.origin === "https://web.whatsapp.com";

  let readinessSignal: DocumentReadySignal | null = document.readyState === "interactive" || document.readyState === "complete"
    ? "ready-state"
    : hasSemanticWhatsAppSurface()
      ? "semantic-surface"
      : null;
  let documentReady = Boolean(readinessSignal);
  if (pageDetected && !documentReady) {
    try {
      readinessSignal = await waitForDocumentReady(timeoutMs, hasSemanticWhatsAppSurface);
      documentReady = true;
    } catch {
      documentReady = false;
      readinessSignal = null;
    }
  }

  if (pageDetected && documentReady && !findQrCode() && !resolveCapability("main_interface").match && !findComposer()) {
    await waitForCondition(
      () => findQrCode() || resolveCapability("main_interface").match || findComposer(),
      {
        timeoutMs,
        description: "la pantalla de acceso o la interfaz principal de WhatsApp",
        observe: { childList: true, subtree: true }
      }
    ).catch(() => null);
  }

  if (pageDetected && documentReady && inspectConversation && request.targetedCapability && !findQrCode() && !findComposer()) {
    await waitForCondition(
      () => findQrCode() || findComposer(),
      {
        timeoutMs,
        description: "una conversación activa para el diagnóstico manual solicitado",
        observe: { childList: true, subtree: true }
      }
    ).catch(() => null);
  }

  const qr = findQrCode();
  const main = resolveCapability("main_interface", document, resolverOptions("main_interface", required.has("main_interface"), request));
  const fallbackComposer = main.match ? null : findComposer();
  const qrDetected = Boolean(qr);
  const mainInterfaceReady = Boolean(main.match || fallbackComposer);
  const sessionReady = mainInterfaceReady && !qrDetected;
  const documentReadyStrategy = readinessSignal === "semantic-surface" ? "document.semantic-surface" : documentReady ? "document.ready-state" : undefined;
  const discoveries: Partial<Record<WhatsAppCapability, CapabilityDiscovery>> = {
    whatsapp_page: syntheticDiscovery("whatsapp_page", pageDetected ? "available" : "unavailable", required.has("whatsapp_page"), "preflight.page", "origen web.whatsapp.com", pageDetected ? "WhatsApp Web detectado." : "Esta página no es WhatsApp Web.", pageDetected ? "origin.web-whatsapp" : undefined, "window"),
    content_script: syntheticDiscovery("content_script", "available", required.has("content_script"), "preflight.content_script", "Content Script conectado", "El Content Script respondió al Service Worker.", "runtime.content-script-response", "script"),
    document_ready: syntheticDiscovery("document_ready", documentReady ? "available" : "unavailable", required.has("document_ready"), "preflight.document_ready", "documento utilizable o readyState interactive/complete", documentReady ? readinessSignal === "semantic-surface" ? "La interfaz semántica de WhatsApp está montada aunque el navegador todavía informe loading." : "El documento terminó de cargar." : "El documento y la interfaz semántica todavía están cargando.", documentReadyStrategy),
    session: syntheticDiscovery("session", sessionReady ? "available" : "unavailable", required.has("session"), "preflight.session", "sesión autenticada sin QR", sessionReady ? "La sesión está iniciada." : qrDetected ? "WhatsApp requiere inicio de sesión manual." : "La sesión todavía no puede confirmarse.", sessionReady ? "session.main-interface-without-qr" : undefined),
    main_interface: main.discovery,
    open_conversation: syntheticDiscovery("open_conversation", sessionReady ? "available" : "unavailable", required.has("open_conversation"), "conversation.open", "navegación segura /send sin envío", sessionReady ? "La navegación a un destinatario explícito está disponible." : "Se necesita una sesión iniciada.", sessionReady ? "navigation.send-url" : undefined, "location")
  };

  if (inspectConversation) {
    inspectConversationCapabilities(request, required, discoveries);
  } else {
    for (const capability of CONVERSATION_CAPABILITIES) discoveries[capability] = notTested(capability, required.has(capability));
  }

  for (const capability of ALL_CAPABILITIES) {
    if (!discoveries[capability]) discoveries[capability] = notTested(capability, required.has(capability));
  }

  const capabilities = discoveries as Record<WhatsAppCapability, CapabilityDiscovery>;
  const criticalFailures = [...required].filter((capability) => capabilities[capability].state !== "available");
  const overallStatus: WhatsAppPreflightResult["overallStatus"] = criticalFailures.length === 0 ? "GREEN" : "RED";
  let status: WhatsAppPreflightResult["status"] = overallStatus === "GREEN" ? "ready" : "incompatible";
  let message = overallStatus === "GREEN"
    ? "WhatsApp está conectado. El envío y su evidencia se validan únicamente con el contenido real y el contacto ya probado."
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
    contentInstanceId: CONTENT_INSTANCE_ID,
    purpose: request.purpose ?? "unspecified",
    diagnosticComposerMutationDetected: false,
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
