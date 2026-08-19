import { DEFAULT_PREFLIGHT_REQUIREMENTS, requiredCapabilities } from "./requirements";
import type {
  CapabilityDiscovery,
  WhatsAppCapability,
  WhatsAppPreflightRequest
} from "./types";
import type { WhatsAppPreflightResult } from "../shared/state";

const CAPABILITIES: WhatsAppCapability[] = [
  "whatsapp_page", "content_script", "document_ready", "session", "main_interface", "open_conversation",
  "composer", "attachment_action", "image_file_input", "media_preview", "media_send_action", "text_send_action",
  "outgoing_text_evidence", "outgoing_media_evidence"
];

export function createUnavailablePreflight(
  message: string,
  request: WhatsAppPreflightRequest = {},
  options: {
    pageDetected?: boolean;
    contentScriptConnected?: boolean;
    status?: WhatsAppPreflightResult["status"];
  } = {}
): WhatsAppPreflightResult {
  const checkedAt = new Date().toISOString();
  const level = request.level ?? "full";
  const requirements = request.requirements ?? DEFAULT_PREFLIGHT_REQUIREMENTS;
  const required = requiredCapabilities(requirements, level);
  if (request.targetedCapability) required.add(request.targetedCapability);
  const capabilities = Object.fromEntries(CAPABILITIES.map((capability): [WhatsAppCapability, CapabilityDiscovery] => [capability, {
    capability,
    logicalStep: `preflight.${capability}`,
    state: "unavailable",
    required: required.has(capability),
    message,
    expectedSemanticElement: capability.replaceAll("_", " "),
    attempts: [],
    candidateCount: 0,
    candidateSummaries: [],
    change: "unknown"
  }])) as Record<WhatsAppCapability, CapabilityDiscovery>;
  return {
    checkedAt,
    pageDetected: options.pageDetected ?? false,
    contentScriptConnected: options.contentScriptConnected ?? false,
    contentInstanceId: null,
    purpose: request.purpose ?? "unspecified",
    diagnosticComposerMutationDetected: false,
    documentReady: false,
    sessionReady: false,
    mainInterfaceReady: false,
    qrDetected: false,
    operational: false,
    overallStatus: "RED",
    level,
    requirements,
    status: options.status ?? "unavailable",
    message,
    capabilities,
    strategiesUsed: [],
    failures: []
  };
}
