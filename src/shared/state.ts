import type { SerializedExtensionError } from "./errors";
import type { ContactProcessCheckpoint } from "../engine/types";
import type { RetryPolicyConfig } from "../engine/retry-policy";
import type { CampaignPolicyConfig, CampaignState, CampaignStatus, DailyLimitState } from "../campaign/campaign-types";

export const EXTENSION_STATES = ["idle", "preflight", "ready", "running", "pausing", "paused", "error", "completed"] as const;
export type ExtensionStatus = (typeof EXTENSION_STATES)[number];

export type CapabilityState = "available" | "unavailable" | "requiresContext" | "notImplemented";

export interface CapabilityResult {
  state: CapabilityState;
  message: string;
  selector?: string;
}

export interface WhatsAppPreflightResult {
  checkedAt: string;
  pageDetected: boolean;
  documentReady: boolean;
  sessionReady: boolean;
  mainInterfaceReady: boolean;
  qrDetected: boolean;
  operational: boolean;
  status: "ready" | "login_required" | "loading" | "unavailable";
  message: string;
  capabilities: {
    openConversation: CapabilityResult;
    composer: CapabilityResult;
    sendText: CapabilityResult;
    multimedia: CapabilityResult;
  };
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
  schemaVersion: 3;
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
  activeCampaign: CampaignState | null;
  dailyLimit: DailyLimitState;
  operations: OperationRecord[];
  updatedAt: string;
}
