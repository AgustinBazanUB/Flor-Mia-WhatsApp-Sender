import type { SerializedExtensionError } from "./errors";
import type { ContactProcessCheckpoint } from "../engine/types";
import type { RetryPolicyConfig } from "../engine/retry-policy";
import type { CampaignPolicyConfig, CampaignPublicStatus, CampaignStatus, DailyLimitState } from "../campaign/campaign-types";
import type {
  CampaignRequirements,
  CapabilityDiscovery,
  CompatibilityFailure,
  CompatibilityOverallStatus,
  CompatibilityState,
  PreflightLevel,
  PreflightPurpose,
  WhatsAppCapability
} from "../compatibility/types";
import type { DiagnosticIncident, ServiceWorkerRecoveryInfo } from "../diagnostics/types";

export const EXTENSION_STATES = ["idle", "preflight", "ready", "running", "pausing", "paused", "error", "completed"] as const;
export type ExtensionStatus = (typeof EXTENSION_STATES)[number];

export interface WhatsAppPreflightResult {
  checkedAt: string;
  pageDetected: boolean;
  contentScriptConnected: boolean;
  contentInstanceId: string | null;
  purpose: PreflightPurpose;
  diagnosticComposerMutationDetected: boolean;
  documentReady: boolean;
  sessionReady: boolean;
  mainInterfaceReady: boolean;
  qrDetected: boolean;
  operational: boolean;
  overallStatus: CompatibilityOverallStatus;
  level: PreflightLevel;
  requirements: CampaignRequirements;
  status: "ready" | "login_required" | "loading" | "unavailable" | "incompatible";
  message: string;
  capabilities: Record<WhatsAppCapability, CapabilityDiscovery>;
  strategiesUsed: string[];
  failures: CompatibilityFailure[];
}

export interface TextVerification {
  confirmed: boolean;
  method: "new-outgoing-message-dom" | "none";
  matchedTextLength?: number;
  messageElementId?: string;
}

export interface TextTestResult {
  success: boolean;
  operationId: string;
  contactId: string;
  maskedPhone: string;
  step: "text";
  startedAt: string;
  completedAt: string;
  verification: TextVerification;
  error?: SerializedExtensionError;
}

export interface CampaignSnapshot {
  campaignId: string;
  campaignName: string;
  createdBy: string;
  totalRecipients: number;
  messageLength: number;
  imageCount: number;
  receivedAt: string;
  status: CampaignStatus;
}

export interface StoredContact {
  recipientId: string;
  name?: string;
  phone: string;
  maskedPhone: string;
}

export interface Checkpoint {
  operationId: string;
  campaignId?: string;
  recipientId?: string;
  step: string;
  createdAt: string;
}

export interface OperationRecord {
  operationId: string;
  kind: "diagnostic" | "text-test" | "campaign-received" | "contact-process";
  success: boolean;
  startedAt: string;
  completedAt: string;
  maskedPhone?: string;
  errorCode?: string;
}

export interface ExtensionConfig {
  webAppOrigins: string[];
  diagnosticTimeoutMs: number;
  operationTimeoutMs: number;
  retryPolicy: RetryPolicyConfig;
  campaignPolicy: CampaignPolicyConfig;
}

export interface ExtensionState {
  schemaVersion: 7;
  extensionVersion: string;
  status: ExtensionStatus;
  currentCampaign: CampaignSnapshot | null;
  progress: { total: number; sent: number; failed: number };
  currentContact: StoredContact | null;
  currentStep: string | null;
  config: ExtensionConfig;
  errors: Array<SerializedExtensionError & { at: string }>;
  lastCheckpoint: Checkpoint | null;
  operational: boolean;
  statusMessage: string;
  whatsapp: WhatsAppPreflightResult | null;
  lastTestResult: TextTestResult | null;
  activeContactProcess: ContactProcessCheckpoint | null;
  activeCampaign: CampaignPublicStatus | null;
  dailyLimit: DailyLimitState;
  compatibility: CompatibilityState;
  diagnosticIncident: DiagnosticIncident | null;
  serviceWorkerRecovery: ServiceWorkerRecoveryInfo | null;
  operations: OperationRecord[];
  updatedAt: string;
}
