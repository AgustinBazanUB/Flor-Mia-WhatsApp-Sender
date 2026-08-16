import type { CampaignProgress, CampaignStatus, DailyLimitState } from "../campaign/campaign-types";
import type { ContactPauseReason, ContactProcessStatus, ContactStepKind } from "../engine/types";
import type { SerializedExtensionError } from "../shared/errors";
import type { CompatibilityOverallStatus, WhatsAppCapability } from "../compatibility/types";

export const DIAGNOSTIC_ERROR_CATEGORIES = [
  "EXTENSION_ERROR",
  "TEMPORARY_WHATSAPP_ERROR",
  "CONNECTION_ERROR",
  "CONTACT_ERROR",
  "AUTH_ERROR",
  "WHATSAPP_UI_CHANGED",
  "AMBIGUOUS_SEND_RESULT",
  "RESOURCE_ERROR",
  "DAILY_LIMIT",
  "USER_PAUSE",
  "USER_STOP"
] as const;

export type DiagnosticErrorCategory = (typeof DIAGNOSTIC_ERROR_CATEGORIES)[number];

export interface DiagnosticIncident {
  incidentSchemaVersion: 1;
  incidentId: string;
  occurredAt: string;
  source: "campaign" | "contact" | "preflight" | "service_worker" | "manual";
  disposition: "paused" | "error" | "blocked" | "stopped";
  campaignId: string | null;
  campaignName: string | null;
  campaignStatus: CampaignStatus | null;
  recipientInternalId: string | null;
  recipientPosition: number | null;
  totalRecipients: number | null;
  contactStatus: ContactProcessStatus | string | null;
  maskedPhone: string | null;
  stepId: string | null;
  stepKind: ContactStepKind | null;
  imageOrder: number | null;
  attempts: number | null;
  actionAttempted: string | null;
  resultSummary: string;
  lastConfirmedStepId: string | null;
  overallStatus: CompatibilityOverallStatus;
  errorCategory: DiagnosticErrorCategory | null;
  error: SerializedExtensionError | null;
  capability: WhatsAppCapability | null;
  lastSuccessfulCapability: WhatsAppCapability | null;
  pauseReason: ContactPauseReason | string | null;
}

export interface TechnicalTraceRecord {
  traceId: string;
  timestampStart: string;
  timestampEnd: string | null;
  campaignId: string;
  contactId: string | null;
  stepId: string | null;
  attempt: number | null;
  action: string;
  outcome: string;
  errorCode: string | null;
  errorCategory: DiagnosticErrorCategory | null;
  verificationMethod: string | null;
  capability: WhatsAppCapability | null;
  strategy: string | null;
  durationMs: number | null;
}

export type TechnicalTraceInput = Omit<TechnicalTraceRecord, "traceId"> & { traceId?: string };

export interface TechnicalTraceState {
  schemaVersion: 1;
  records: TechnicalTraceRecord[];
  updatedAt: string;
}

export interface SanitizedCampaignReport {
  campaignId: string;
  campaignName: string | null;
  status: CampaignStatus;
  totalRecipients: number;
  completedRecipients: number;
  progress: CampaignProgress;
  activeRecipient: {
    recipientInternalId: string;
    position: number;
    maskedPhone: string;
    status: string;
  } | null;
  messageMetadata: {
    length: number;
    localFingerprint: string | null;
  };
  images: Array<{ order: number; type: string; size: number }>;
  dailyLimit: SanitizedDailyLimit;
  blockReason: {
    code: string;
    message: string;
    recoverable: boolean;
    at: string;
  } | null;
}

export type SanitizedDailyLimit = Omit<DailyLimitState, "countedContactKeys"> & {
  countedContacts: number;
};

export interface SanitizedCheckpointReport {
  schemaVersion: number;
  checkpointId: string;
  campaignId: string;
  contact: { recipientInternalId: string; maskedPhone: string };
  status: ContactProcessStatus;
  currentStepId: string | null;
  lastConfirmedStepId: string | null;
  openConversationAttempts: number;
  pauseReason: string | null;
  error: SerializedExtensionError | null;
  steps: Array<{
    id: string;
    kind: ContactStepKind;
    status: string;
    attempts: number;
    imageOrder: number | null;
    startedAt: string | null;
    completedAt: string | null;
    verification: {
      outcome: string;
      method: string;
      sendAttempted: boolean;
    } | null;
    error: SerializedExtensionError | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface DiagnosticEnvironment {
  chromeVersion: string | null;
  sanitizedUserAgent: string | null;
  timezone: string | null;
  timezoneOffsetMinutes: number;
  online: boolean | null;
  whatsappUrl: string | null;
  connectionState: "online" | "offline" | "unknown";
  documentReadyState: string | null;
  whatsappLoadState: string | null;
}

export interface ServiceWorkerRecoveryInfo {
  recoveredAt: string;
  campaignId: string | null;
  campaignStatus: CampaignStatus | null;
  checkpointPresent: boolean;
  checkpointStatus: ContactProcessStatus | null;
}

export interface TechnicalReportV1 {
  reportSchemaVersion: 1;
  generatedAt: string;
  extension: {
    name: "Flor Mía WhatsApp Sender";
    extensionVersion: string;
    manifestVersion: number;
  };
  environment: DiagnosticEnvironment;
  incident: DiagnosticIncident;
  campaign: SanitizedCampaignReport | null;
  checkpoint: SanitizedCheckpointReport | null;
  preflight: Record<string, unknown> | null;
  compatibility: {
    overallStatus: CompatibilityOverallStatus;
    checkedAt: string | null;
    failedCapability: WhatsAppCapability | null;
    lastSuccessfulCapability: WhatsAppCapability | null;
    lastKnownGood: Record<string, unknown>;
    currentDiscovery: Record<string, unknown> | null;
    driftChanges: Array<Record<string, unknown>>;
    breakChanges: Array<Record<string, unknown>>;
  };
  dailyLimit: SanitizedDailyLimit | null;
  recentTechnicalOperations: Array<Record<string, unknown>>;
  trace: TechnicalTraceRecord[];
  serviceWorkerRecovery: ServiceWorkerRecoveryInfo | null;
  repairContext: {
    probableFiles: string[];
    restrictions: string[];
  };
  privacy: {
    localOnly: true;
    campaignNameIncluded: boolean;
    excludedByDefault: string[];
    redactionMarker: "[REDACTED]";
  };
}

export interface DiagnosticReportBundle {
  report: TechnicalReportV1;
  text: string;
  json: string;
}
