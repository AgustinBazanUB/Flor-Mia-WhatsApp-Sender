import type { SerializedExtensionError } from "../shared/errors";
import type { CompatibilityOverallStatus } from "../compatibility/types";
import type { DiagnosticErrorCategory } from "../diagnostics/types";

export const CAMPAIGN_STATUSES = [
  "received",
  "ready",
  "running",
  "pause_requested",
  "paused",
  "waiting_contact",
  "waiting_batch",
  "daily_limit_reached",
  "images_required",
  "error",
  "stopped",
  "cancelled",
  "completed"
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type CampaignRecipientStatus = "pending" | "active" | "paused" | "images_required" | "error" | "stopped" | "cancelled" | "completed";
export type CampaignWaitKind = "between_contacts" | "between_batches";

export interface CampaignPolicyConfig {
  contactsPerBatch: number;
  delayBetweenContactsMs: number;
  delayBetweenBatchesMs: number;
  dailyContactLimit: number;
  whatsappLoadWaitMs: number;
}

export interface DailyLimitState {
  localDate: string;
  completedToday: number;
  limit: number;
  remaining: number;
  countedContactKeys: string[];
  updatedAt: string;
}

export interface CampaignRecipientFailure {
  errorCode: string;
  errorCategory: DiagnosticErrorCategory;
  operation: string;
  stage: string;
  capability: string | null;
  attempts: number;
  sendAttempted: boolean;
  ambiguous: boolean;
  reconciled: boolean;
  retryEligible: boolean;
  signature: string;
  failedAt: string;
}

export interface CampaignRecipientState {
  recipientId: string;
  clientId?: string | null;
  name?: string;
  phoneDigits: string;
  maskedPhone: string;
  source: "flor_mia" | "excel";
  position: number;
  status: CampaignRecipientStatus;
  startedAt?: string;
  completedAt?: string;
  error?: SerializedExtensionError;
  failure?: CampaignRecipientFailure;
  deliveryConfidence?: "confirmed" | "unverified";
}

export type CampaignRecipientOutcome = "confirmed" | "unverified" | "failed";

/**
 * Resultado mínimo que puede volver a la Web App.
 * No expone nombre ni teléfono: recipientId identifica el snapshot persistido
 * por la campaña y la Web App resuelve allí el clientId confiable.
 */
export interface CampaignRecipientResult {
  recipientId: string;
  outcome: CampaignRecipientOutcome;
  completedAt: string;
}

export interface CampaignImageAsset {
  imageId: string;
  order: number;
  name: string;
  type: string;
  size: number;
}

export interface CampaignWaitState {
  kind: CampaignWaitKind;
  until: string;
  scheduledAt: string;
}

export type CampaignBlockCode =
  | "manual_pause"
  | "daily_limit_reached"
  | "images_required"
  | "contact_ambiguous"
  | "contact_paused"
  | "contact_failed"
  | "repeated_contact_failures"
  | "whatsapp_reloading"
  | "whatsapp_tab_closed"
  | "whatsapp_session_closed"
  | "whatsapp_ui_changed"
  | "service_worker_restarted";

export interface CampaignBlockReason {
  code: CampaignBlockCode;
  message: string;
  at: string;
  recoverable: boolean;
  error?: SerializedExtensionError;
}

export interface CampaignProgress {
  /** Compatibilidad: representa destinatarios procesados de forma terminal. */
  completed: number;
  total: number;
  percentage: number;
}

export interface CampaignPublicDailyLimit {
  localDate: string;
  completedToday: number;
  limit: number;
  remaining: number;
  countedContacts: number;
  updatedAt: string;
}

export interface CampaignFailureCircuit {
  signature: string | null;
  consecutive: number;
  threshold: number;
  updatedAt: string;
}

export interface CampaignState {
  schemaVersion: 1;
  runToken?: string;
  retryCycle?: number;
  campaignId: string;
  campaignName: string;
  createdBy: string;
  status: CampaignStatus;
  recipients: CampaignRecipientState[];
  text: string;
  images: CampaignImageAsset[];
  currentRecipientIndex: number | null;
  activeContactId: string | null;
  lastCompletedContactId: string | null;
  /** Sólo destinatarios con todos sus envíos confirmados. */
  completedRecipients: number;
  batchNumber: number;
  contactsCompletedInBatch: number;
  pauseRequested: boolean;
  stopRequested: boolean;
  cancelRequested?: boolean;
  wait: CampaignWaitState | null;
  blockReason: CampaignBlockReason | null;
  failureCircuit?: CampaignFailureCircuit;
  policy: CampaignPolicyConfig;
  dailyLimit: DailyLimitState;
  sequence: number;
  receivedAt: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  stoppedAt?: string;
  cancelledAt?: string;
}

export interface CampaignPublicStatus {
  snapshotSchemaVersion: 1;
  campaignId: string;
  campaignName: string;
  receivedAt: string;
  acceptedAt: string;
  status: CampaignStatus;
  progress: CampaignProgress;
  progressPercentage: number;
  processed: number;
  sent: number;
  confirmedSent: number;
  unverifiedSent: number;
  failed: number;
  total: number;
  remaining: number;
  currentRecipientIndex: number | null;
  currentRecipientId: string | null;
  currentRecipientName?: string;
  maskedPhone: string | null;
  currentStep: string | null;
  batch: {
    number: number;
    completedInBatch: number;
    size: number;
  };
  sentToday: number;
  availableToday: number;
  dailyLimitValue: number;
  errorSummary: {
    code: string | null;
    category: DiagnosticErrorCategory;
    message: string;
    recoverable: boolean;
  } | null;
  redGreen: CompatibilityOverallStatus;
  updatedAt: string;
  extensionVersion: string;
  currentContact: {
    position: number;
    total: number;
    name?: string;
    maskedPhone: string;
  } | null;
  currentStepId: string | null;
  lastConfirmedStepId: string | null;
  wait: CampaignWaitState | null;
  dailyLimit: CampaignPublicDailyLimit;
  blockReason: CampaignBlockReason | null;
  pauseRequested: boolean;
  stopRequested: boolean;
  cancelRequested?: boolean;
  sequence: number;
  retryCycle: number;
  retryableFailed: number;
  /** Último resultado terminal individual, acotado e idempotente para sincronizar con la Web App. */
  lastRecipientResult: CampaignRecipientResult | null;
  finalSummary: FinalCampaignSummary | null;
}

export interface CancellationEvidenceSummary {
  stepId: string | null;
  operationId: string | null;
  sendAttempted: boolean;
  verificationOutcome: string | null;
  observedAt: string | null;
  errorCategory: DiagnosticErrorCategory | null;
  maskedPhone: string | null;
}

export interface FinalCampaignSummary {
  campaignId: string;
  terminalStatus: "completed" | "stopped" | "cancelled";
  completedAt: string;
  total: number;
  processed: number;
  sent: number;
  confirmedSent: number;
  unverifiedSent: number;
  failed: number;
  durationMs: number;
  batches: number;
  sentToday: number;
  extensionVersion: string;
  lastCompletedContactId: string | null;
  cancellationEvidence: CancellationEvidenceSummary | null;
}

export interface CampaignHistoryRecord {
  historySchemaVersion: 1;
  campaignId: string;
  campaignName: string;
  createdAt?: string;
  startedAt: string | null;
  completedAt: string;
  cancelledAt?: string | null;
  total: number;
  completed: number;
  failed?: number;
  processed?: number;
  confirmedSent?: number;
  unverifiedSent?: number;
  retryCycle?: number;
  status: Extract<CampaignStatus, "completed" | "stopped" | "cancelled">;
  errorCategory: DiagnosticErrorCategory | null;
  lastCompletedContactId?: string | null;
  cancellationEvidence?: CancellationEvidenceSummary | null;
  extensionVersion: string;
  dailyCounterImpact: number;
  durationMs: number;
  batches: number;
  recordedAt: string;
}

export interface CampaignHistoryRepository {
  upsert(record: CampaignHistoryRecord): Promise<CampaignHistoryRecord>;
  list(): Promise<CampaignHistoryRecord[]>;
}

export interface CampaignRepository {
  loadActive(): Promise<CampaignState | null>;
  saveActive(campaign: CampaignState): Promise<CampaignState>;
  clearActive(): Promise<void>;
}

export interface DailyLimitRepository {
  load(limit: number, now?: Date): Promise<DailyLimitState>;
  recordCompletion(limit: number, completionKey: string, now?: Date): Promise<DailyLimitState>;
}