import type { SerializedExtensionError } from "../shared/errors";

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
  campaignId: string;
  campaignName: string;
  status: CampaignStatus;
  progress: CampaignProgress;
  currentContact: {
    position: number;
    total: number;
    name?: string;
    maskedPhone: string;
  } | null;
  currentStepId: string | null;
  lastConfirmedStepId: string | null;
  wait: CampaignWaitState | null;
  dailyLimit: DailyLimitState;
  blockReason: CampaignBlockReason | null;
  pauseRequested: boolean;
  stopRequested: boolean;
  sequence: number;
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
