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
  "completed"
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type CampaignRecipientStatus = "pending" | "active" | "paused" | "images_required" | "error" | "stopped" | "completed";
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

export interface CampaignState {
  schemaVersion: 1;
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
  completedRecipients: number;
  batchNumber: number;
  contactsCompletedInBatch: number;
  pauseRequested: boolean;
  stopRequested: boolean;
  wait: CampaignWaitState | null;
  blockReason: CampaignBlockReason | null;
  policy: CampaignPolicyConfig;
  dailyLimit: DailyLimitState;
  sequence: number;
  receivedAt: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  stoppedAt?: string;
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
  sent: number;
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
  sequence: number;
  finalSummary: FinalCampaignSummary | null;
}

export interface FinalCampaignSummary {
  campaignId: string;
  completedAt: string;
  total: number;
  sent: number;
  failed: number;
  durationMs: number;
  batches: number;
  sentToday: number;
  extensionVersion: string;
}

export interface CampaignHistoryRecord {
  historySchemaVersion: 1;
  campaignId: string;
  campaignName: string;
  startedAt: string | null;
  completedAt: string;
  total: number;
  completed: number;
  status: Extract<CampaignStatus, "completed" | "stopped">;
  errorCategory: DiagnosticErrorCategory | null;
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
