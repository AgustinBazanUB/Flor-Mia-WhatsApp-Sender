export const WHATSAPP_CAPABILITIES = [
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
] as const;

export type WhatsAppCapability = (typeof WHATSAPP_CAPABILITIES)[number];
export type CapabilityState = "available" | "unavailable" | "requires_context" | "not_tested";
export type CompatibilityOverallStatus = "GREEN" | "RED";
export type CompatibilityChange = "stable" | "drift" | "break" | "unknown";
export type PreflightLevel = "full" | "lightweight" | "targeted";

export interface CampaignRequirements {
  needsText: boolean;
  needsImages: boolean;
}

export interface CandidateSummary {
  tagName: string;
  role?: string;
  ariaLabel?: string;
  dataTestId?: string;
  dataIcon?: string;
  type?: string;
  contentEditable?: string;
  hierarchyHint?: string;
}

export interface SelectorFingerprint {
  strategyId: string;
  method: string;
  tagName: string;
  role?: string;
  attributes: Record<string, string>;
  semanticFingerprint: string;
}

export interface StrategyAttempt {
  strategyId: string;
  method: string;
  priority: number;
  result: "matched" | "not_found" | "ambiguous" | "disabled";
  matchedCount: number;
  selectedCandidate?: CandidateSummary;
  candidates: CandidateSummary[];
}

export interface CapabilityDiscovery {
  capability: WhatsAppCapability;
  logicalStep: string;
  state: CapabilityState;
  required: boolean;
  message: string;
  expectedSemanticElement: string;
  selectedStrategy?: string;
  attempts: StrategyAttempt[];
  candidateCount: number;
  candidateSummaries: CandidateSummary[];
  fingerprint?: SelectorFingerprint;
  change: CompatibilityChange;
}

export interface CompatibilityFailure {
  capability: WhatsAppCapability;
  logicalStep: string;
  expectedStrategies: string[];
  lastKnownWorkingStrategy?: string;
  currentStrategiesAttempted: StrategyAttempt[];
  expectedSemanticElement: string;
  candidateCount: number;
  candidateSummaries: CandidateSummary[];
  lastSuccessfulCapability?: WhatsAppCapability;
  classification: "temporary" | "break" | "context_required" | "not_tested";
  campaignId?: string;
  maskedContact?: string;
  stepId?: string;
  attempts?: number;
  timestamp: string;
}

export interface LastKnownGoodCapability {
  capability: WhatsAppCapability;
  extensionVersion: string;
  lastWorkingAt: string;
  selectedStrategy: string;
  selectorFingerprint: SelectorFingerprint;
  semanticFingerprint: string;
}

export interface CompatibilitySnapshot {
  checkedAt: string;
  overallStatus: CompatibilityOverallStatus;
  level: PreflightLevel;
  requirements: CampaignRequirements;
  capabilities: Partial<Record<WhatsAppCapability, {
    state: CapabilityState;
    selectedStrategy?: string;
    change: CompatibilityChange;
  }>>;
  strategiesUsed: string[];
  failures: CompatibilityFailure[];
}

export const COMPATIBILITY_DEVELOPMENT_FAULTS = [
  "none",
  "primary_strategy_unavailable",
  "attachment_capability_break",
  "main_interface_capability_break",
  "next_health_check_break"
] as const;
export type CompatibilityDevelopmentFault = (typeof COMPATIBILITY_DEVELOPMENT_FAULTS)[number];

export function isCompatibilityDevelopmentFault(value: unknown): value is CompatibilityDevelopmentFault {
  return typeof value === "string" && (COMPATIBILITY_DEVELOPMENT_FAULTS as readonly string[]).includes(value);
}

export interface CompatibilityState {
  schemaVersion: 1;
  overallStatus: CompatibilityOverallStatus;
  checkedAt: string | null;
  lastKnownGood: Partial<Record<WhatsAppCapability, LastKnownGoodCapability>>;
  lastPreflight: CompatibilitySnapshot | null;
  driftHistory: Array<{
    capability: WhatsAppCapability;
    fromStrategy: string;
    toStrategy: string;
    detectedAt: string;
  }>;
  lastFailure: CompatibilityFailure | null;
  developmentFault: CompatibilityDevelopmentFault;
  updatedAt: string;
}

export interface PreflightProbeImage {
  name: string;
  type: string;
  size: number;
  dataBase64: string;
}

export interface WhatsAppPreflightRequest {
  timeoutMs?: number;
  level?: PreflightLevel;
  requirements?: CampaignRequirements;
  probeImage?: PreflightProbeImage;
  developmentFault?: CompatibilityDevelopmentFault;
  targetedCapability?: WhatsAppCapability;
}
