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

const CONVERSATION_CONTEXT_CAPABILITIES = new Set<WhatsAppCapability>([
  "composer",
  "attachment_action",
  "image_file_input",
  "media_preview",
  "media_send_action",
  "text_send_action",
  "outgoing_text_evidence",
  "outgoing_media_evidence"
]);

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

function discoverTextSendAction(required: boolean, request: WhatsAppPreflightRequest): CapabilityDiscovery {
  const discovery = resolveCapability("text_send_action", document, resolverOptions("text_send_action", required, request)).discovery;
  if (discovery.state === "available" || !required) return discovery;
  return markContextRequired(
    discovery,
    "La acción de envío de texto se valida durante el step real, después de insertar el contenido real de campaña. El preflight no modifica el composer."
  );
}

function discoverMediaContext(
  required: Set<WhatsAppCapability>,
  request: WhatsAppPreflightRequest,
  discoveries: Partial<Record<WhatsAppCapability, CapabilityDiscovery>>
): void {
  const preview = resolveCapability("media_preview", document, resolverOptions("media_preview", required.has("media_preview"), request));
  discoveries.media_preview = preview.match
    ? preview.discovery
    : markContextRequired(preview.discovery, "El preview multimedia se valida únicamente con la imagen real durante el step de envío.");

  if (preview.match) {
    const scoped = resolveCapability("media_send_action", preview.match.element, resolverOptions("media_send_action", required.has("media_send_action"), request));
    const fallback = scoped.match
      ? scoped
      : resolveCapability("media_send_action", document, resolverOptions("media_send_action", required.has("media_send_action"), request));
    discoveries.media_send_action = fallback.discovery;
    return;
  }
  const send = resolveCapability("media_send_action", document, resolverOptions("media_send_action", required.has("media_send_action"), request)).discovery;
  discoveries.media_send_action = markContextRequired(
    send,
    "La acción multimedia se valida dentro de un preview real; el preflight automático no adjunta archivos ni abre previews artificiales."
  );
}

function hasSemanticWhatsAppSurface(): boolean {
  return Boolean(findQrCode() || resolveCapability("main_interface").match || findComposer());
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
      { timeoutMs, description: "la pantalla de acceso o la interfaz principal de WhatsApp" }
    ).catch(() => null);
  }

  const requiresConversationContext = [...required].some((capability) => CONVERSATION_CONTEXT_CAPABILITIES.has(capability));
  if (pageDetected && documentReady && requiresConversationContext && !findQrCode() && !findComposer()) {
    await waitForCondition(
      () => findQrCode() || findComposer(),
      { timeoutMs, description: "una conversación activa para el diagnóstico manual solicitado" }
    ).catch(() => null);
  }

  const qr = findQrCode();
  const main = resolveCapability("main_interface", document, resolverOptions("main_interface", required.has("main_interface"), request));
  const composer = resolveCapability("composer", document, resolverOptions("composer", required.has("composer"), request));
  const qrDetected = Boolean(qr);
  const mainInterfaceReady = Boolean(main.match || composer.match);
  const sessionReady = mainInterfaceReady && !qrDetected;
  const documentReadyStrategy = readinessSignal === "semantic-surface" ? "document.semantic-surface" : documentReady ? "document.ready-state" : undefined;
  const discoveries: Partial<Record<WhatsAppCapability, CapabilityDiscovery>> = {
    whatsapp_page: syntheticDiscovery("whatsapp_page", pageDetected ? "available" : "unavailable", required.has("whatsapp_page"), "preflight.page", "origen web.whatsapp.com", pageDetected ? "WhatsApp Web detectado." : "Esta página no es WhatsApp Web.", pageDetected ? "origin.web-whatsapp" : undefined, "window"),
    content_script: syntheticDiscovery("content_script", "available", required.has("content_script"), "preflight.content_script", "Content Script conectado", "El Content Script respondió al Service Worker.", "runtime.content-script-response", "script"),
    document_ready: syntheticDiscovery("document_ready", documentReady ? "available" : "unavailable", required.has("document_ready"), "preflight.document_ready", "documento utilizable o readyState interactive/complete", documentReady ? readinessSignal === "semantic-surface" ? "La interfaz semántica de WhatsApp está montada aunque el navegador todavía informe loading." : "El documento terminó de cargar." : "El documento y la interfaz semántica todavía están cargando.", documentReadyStrategy),
    session: syntheticDiscovery("session", sessionReady ? "available" : "unavailable", required.has("session"), "preflight.session", "sesión autenticada sin QR", sessionReady ? "La sesión está iniciada." : qrDetected ? "WhatsApp requiere inicio de sesión manual." : "La sesión todavía no puede confirmarse.", sessionReady ? "session.main-interface-without-qr" : undefined),
    main_interface: main.discovery,
    open_conversation: syntheticDiscovery("open_conversation", sessionReady ? "available" : "unavailable", required.has("open_conversation"), "conversation.open", "navegación segura /send sin envío", sessionReady ? "La navegación a un destinatario explícito está disponible." : "Se necesita una sesión iniciada.", sessionReady ? "navigation.send-url" : undefined, "location"),
    composer: composer.match ? composer.discovery : markContextRequired(composer.discovery, "El composer se valida después de abrir y probar la conversación correcta."),
    attachment_action: resolveCapability("attachment_action", document, resolverOptions("attachment_action", required.has("attachment_action"), request)).discovery,
    image_file_input: resolveCapability("image_file_input", document, resolverOptions("image_file_input", required.has("image_file_input"), request)).discovery,
    outgoing_text_evidence: resolveCapability("outgoing_text_evidence", document, resolverOptions("outgoing_text_evidence", required.has("outgoing_text_evidence"), request)).discovery,
    outgoing_media_evidence: resolveCapability("outgoing_media_evidence", document, resolverOptions("outgoing_media_evidence", required.has("outgoing_media_evidence"), request)).discovery
  };

  if (!composer.match) {
    for (const capability of ["attachment_action", "image_file_input", "outgoing_text_evidence", "outgoing_media_evidence"] as const) {
      if (discoveries[capability]?.state === "unavailable") {
        discoveries[capability] = markContextRequired(discoveries[capability]!, "Esta capability se valida dentro de una conversación real ya probada.");
      }
    }
  }
  discoveries.text_send_action = discoverTextSendAction(required.has("text_send_action"), request);
  discoverMediaContext(required, request, discoveries);

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
    ? "WhatsApp está conectado y las capacidades no destructivas necesarias están disponibles. Las acciones de envío se validarán con el contenido real."
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
