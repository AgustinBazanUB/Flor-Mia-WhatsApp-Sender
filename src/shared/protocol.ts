import type { SerializedCampaignPayload } from "./serialization";
import type { SerializedCampaignImage } from "./serialization";
import type { ExtensionState, TextTestResult, WhatsAppPreflightResult } from "./state";
import type { ContactProcessCheckpoint, StepReconciliationResult } from "../engine/types";
import type { DevelopmentFault } from "../engine/fault-injection";
import type { ImageSendInput, ImageSendResult } from "../whatsapp/send-image";
import type { ReconcileStepInput } from "../whatsapp/reconcile";
import type { CampaignPublicStatus } from "../campaign/campaign-types";
import type {
  CompatibilityDevelopmentFault,
  CompatibilityState,
  WhatsAppPreflightRequest
} from "../compatibility/types";
import type { DiagnosticReportBundle } from "../diagnostics/types";
import type { CompatibilityOverallStatus } from "../compatibility/types";
import type { ConversationContextProof } from "../whatsapp/conversation-context";
import type {
  WhatsAppInboxChat,
  WhatsAppInboxConversation,
  WhatsAppInboxSendResult
} from "../whatsapp/inbox-adapter";

export const INTERNAL_CHANNEL = "flor_mia_whatsapp_sender_internal";
export const WEB_APP_CHANNEL = "flor_mia_whatsapp_extension";
export const PROTOCOL_VERSION = 1;

export const INTERNAL_MESSAGE_TYPES = {
  getState: "GET_EXTENSION_STATE",
  runPreflight: "RUN_WHATSAPP_PREFLIGHT",
  setCompatibilityDevelopmentFault: "SET_COMPATIBILITY_DEVELOPMENT_FAULT",
  generateDiagnosticReport: "GENERATE_DIAGNOSTIC_REPORT",
  sendTestText: "SEND_TEST_TEXT",
  processTestContact: "PROCESS_TEST_CONTACT",
  resumeContactProcess: "RESUME_CONTACT_PROCESS",
  reselectContactImages: "RESELECT_CONTACT_IMAGES",
  campaignStart: "CAMPAIGN_START",
  campaignPause: "CAMPAIGN_PAUSE",
  campaignResume: "CAMPAIGN_RESUME",
  campaignRetry: "CAMPAIGN_RETRY",
  campaignRetryFailed: "CAMPAIGN_RETRY_FAILED",
  campaignStop: "CAMPAIGN_STOP",
  campaignCancel: "CAMPAIGN_CANCEL",
  campaignDelete: "CAMPAIGN_DELETE",
  campaignStatus: "CAMPAIGN_STATUS",
  campaignRestoreImages: "CAMPAIGN_RESTORE_IMAGES",
  whatsappPreflight: "WA_PREFLIGHT",
  whatsappOpenConversation: "WA_OPEN_CONVERSATION",
  whatsappProveConversation: "WA_PROVE_CONVERSATION",
  whatsappCancelOperation: "WA_CANCEL_OPERATION",
  whatsappSendText: "WA_SEND_TEXT",
  whatsappSendImage: "WA_SEND_IMAGE",
  whatsappReconcileStep: "WA_RECONCILE_STEP",
  whatsappOperationStage: "WA_OPERATION_STAGE",
  whatsappDiagnosticSnapshot: "WA_DIAGNOSTIC_SNAPSHOT",
  whatsappInboxGetChats: "WA_INBOX_GET_CHATS",
  whatsappInboxGetMessages: "WA_INBOX_GET_MESSAGES",
  whatsappInboxSendText: "WA_INBOX_SEND_TEXT",
  webAppPing: "WEB_APP_PING",
  webAppPrepareCampaign: "WEB_APP_PREPARE_CAMPAIGN",
  webAppCancelCampaign: "WEB_APP_CANCEL_CAMPAIGN",
  webAppInboxGetChats: "WEB_APP_INBOX_GET_CHATS",
  webAppInboxGetMessages: "WEB_APP_INBOX_GET_MESSAGES",
  webAppInboxSendText: "WEB_APP_INBOX_SEND_TEXT"
} as const;

export type InternalMessageType = (typeof INTERNAL_MESSAGE_TYPES)[keyof typeof INTERNAL_MESSAGE_TYPES];
export type InternalSource = "popup" | "diagnostics-page" | "service-worker" | "whatsapp-content" | "web-app-bridge";

export interface InternalRequestMap {
  GET_EXTENSION_STATE: Record<string, never>;
  RUN_WHATSAPP_PREFLIGHT: { developmentFault?: CompatibilityDevelopmentFault };
  SET_COMPATIBILITY_DEVELOPMENT_FAULT: { fault: CompatibilityDevelopmentFault };
  GENERATE_DIAGNOSTIC_REPORT: { includeCampaignName?: boolean; webAppContext?: Record<string, unknown> };
  SEND_TEST_TEXT: { phone: string; message: string };
  PROCESS_TEST_CONTACT: { phone: string; message: string; images: SerializedCampaignImage[]; faultInjection?: DevelopmentFault };
  RESUME_CONTACT_PROCESS: Record<string, never>;
  RESELECT_CONTACT_IMAGES: { campaignId: string; images: SerializedCampaignImage[] };
  CAMPAIGN_START: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_PAUSE: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_RESUME: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_RETRY: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_RETRY_FAILED: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_STOP: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_CANCEL: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_DELETE: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_STATUS: { campaignId?: string };
  CAMPAIGN_RESTORE_IMAGES: { campaignId: string; images: SerializedCampaignImage[] };
  WA_PREFLIGHT: WhatsAppPreflightRequest;
  WA_OPEN_CONVERSATION: { operationId: string; phoneDigits: string; navigationRequestId: string };
  WA_PROVE_CONVERSATION: {
    operationId: string;
    phoneDigits: string;
    navigationRequestId: string;
    timeoutMs?: number;
    requestedNavigationAt?: string;
    navigationObservedAt?: string;
    expectedContentInstanceId?: string;
  };
  WA_CANCEL_OPERATION: { operationId: string };
  WA_SEND_TEXT: { operationId: string; phoneDigits: string; message: string; timeoutMs?: number; checkpointRequired?: boolean };
  WA_SEND_IMAGE: ImageSendInput;
  WA_RECONCILE_STEP: ReconcileStepInput;
  WA_OPERATION_STAGE: { operationId: string; stage: "send_attempted"; baselineOutgoingIds: string[] };
  WA_DIAGNOSTIC_SNAPSHOT: Record<string, never>;
  WA_INBOX_GET_CHATS: { limit?: number };
  WA_INBOX_GET_MESSAGES: { chatId: string; limit?: number };
  WA_INBOX_SEND_TEXT: { chatId: string; message: string };
  WEB_APP_PING: Record<string, never>;
  WEB_APP_PREPARE_CAMPAIGN: SerializedCampaignPayload;
  WEB_APP_CANCEL_CAMPAIGN: { campaignId: string };
  WEB_APP_INBOX_GET_CHATS: { limit?: number };
  WEB_APP_INBOX_GET_MESSAGES: { chatId: string; limit?: number };
  WEB_APP_INBOX_SEND_TEXT: { chatId: string; message: string };
}

export interface InternalResponseMap {
  GET_EXTENSION_STATE: ExtensionState;
  RUN_WHATSAPP_PREFLIGHT: WhatsAppPreflightResult;
  SET_COMPATIBILITY_DEVELOPMENT_FAULT: CompatibilityState;
  GENERATE_DIAGNOSTIC_REPORT: DiagnosticReportBundle;
  SEND_TEST_TEXT: TextTestResult;
  PROCESS_TEST_CONTACT: ContactProcessCheckpoint;
  RESUME_CONTACT_PROCESS: ContactProcessCheckpoint;
  RESELECT_CONTACT_IMAGES: ContactProcessCheckpoint;
  CAMPAIGN_START: CampaignPublicStatus;
  CAMPAIGN_PAUSE: CampaignPublicStatus;
  CAMPAIGN_RESUME: CampaignPublicStatus;
  CAMPAIGN_RETRY: CampaignPublicStatus;
  CAMPAIGN_RETRY_FAILED: CampaignPublicStatus;
  CAMPAIGN_STOP: CampaignPublicStatus;
  CAMPAIGN_CANCEL: CampaignPublicStatus;
  CAMPAIGN_DELETE: { campaignId: string; releasedAt: string };
  CAMPAIGN_STATUS: CampaignPublicStatus | null;
  CAMPAIGN_RESTORE_IMAGES: CampaignPublicStatus;
  WA_PREFLIGHT: WhatsAppPreflightResult;
  WA_OPEN_CONVERSATION: { navigationStarted: true; requestedNavigationAt: string; contentInstanceId: string; navigationRequestId: string };
  WA_PROVE_CONVERSATION: ConversationContextProof;
  WA_CANCEL_OPERATION: { cancelled: boolean };
  WA_SEND_TEXT: TextTestResult;
  WA_SEND_IMAGE: ImageSendResult;
  WA_RECONCILE_STEP: StepReconciliationResult;
  WA_OPERATION_STAGE: { recorded: boolean };
  WA_DIAGNOSTIC_SNAPSHOT: {
    contentInstanceId: string;
    documentReadyState: string;
    composerPresent: boolean;
    activeProofControllers: number;
    runtimeMetrics: Record<string, unknown>;
  };
  WA_INBOX_GET_CHATS: WhatsAppInboxChat[];
  WA_INBOX_GET_MESSAGES: WhatsAppInboxConversation;
  WA_INBOX_SEND_TEXT: WhatsAppInboxSendResult;
  WEB_APP_PING: FlorMiaExtensionStatus;
  WEB_APP_PREPARE_CAMPAIGN: CampaignPublicStatus;
  WEB_APP_CANCEL_CAMPAIGN: CampaignPublicStatus & { emitterReleased: true };
  WEB_APP_INBOX_GET_CHATS: WhatsAppInboxChat[];
  WEB_APP_INBOX_GET_MESSAGES: WhatsAppInboxConversation;
  WEB_APP_INBOX_SEND_TEXT: WhatsAppInboxSendResult;
}

export interface InternalEnvelope<T extends InternalMessageType = InternalMessageType> {
  channel: typeof INTERNAL_CHANNEL;
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  source: InternalSource;
  type: T;
  payload: InternalRequestMap[T];
}

export interface InternalResponse<T> {
  ok: boolean;
  requestId: string;
  data?: T;
  error?: { code: string; message: string; recoverable: boolean; details?: Record<string, unknown> };
}

const internalTypes = new Set<string>(Object.values(INTERNAL_MESSAGE_TYPES));

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createInternalRequest<T extends InternalMessageType>(
  source: InternalSource,
  type: T,
  payload: InternalRequestMap[T],
  requestId: string = globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}`
): InternalEnvelope<T> {
  return { channel: INTERNAL_CHANNEL, protocolVersion: PROTOCOL_VERSION, requestId, source, type, payload };
}

export function isInternalEnvelope(value: unknown): value is InternalEnvelope {
  if (!isRecord(value)) return false;
  return value.channel === INTERNAL_CHANNEL
    && value.protocolVersion === PROTOCOL_VERSION
    && typeof value.requestId === "string"
    && ["popup", "diagnostics-page", "service-worker", "whatsapp-content", "web-app-bridge"].includes(String(value.source))
    && typeof value.type === "string"
    && internalTypes.has(value.type)
    && isRecord(value.payload);
}

export async function sendRuntimeRequest<T extends InternalMessageType>(
  source: InternalSource,
  type: T,
  payload: InternalRequestMap[T],
  requestId?: string
): Promise<InternalResponseMap[T]> {
  const request = createInternalRequest(source, type, payload, requestId);
  const response = await chrome.runtime.sendMessage(request) as InternalResponse<InternalResponseMap[T]> | undefined;
  if (!response) throw new Error("La extensión no respondió.");
  if (!response.ok || response.data === undefined) {
    const error = new Error(response.error?.message || "La operación falló.");
    Object.assign(error, { code: response.error?.code, details: response.error?.details });
    throw error;
  }
  return response.data;
}

export const WEB_APP_MESSAGE_TYPES = {
  ping: "FLORMIA_EXTENSION_PING",
  preflightRequest: "FLORMIA_EXTENSION_PREFLIGHT_REQUEST",
  status: "FLORMIA_EXTENSION_STATUS",
  prepare: "FLORMIA_CAMPAIGN_PREPARE",
  accepted: "FLORMIA_CAMPAIGN_ACCEPTED",
  started: "FLORMIA_CAMPAIGN_STARTED",
  progress: "FLORMIA_CAMPAIGN_PROGRESS",
  paused: "FLORMIA_CAMPAIGN_PAUSED",
  resumed: "FLORMIA_CAMPAIGN_RESUMED",
  completed: "FLORMIA_CAMPAIGN_COMPLETED",
  error: "FLORMIA_CAMPAIGN_ERROR",
  stopped: "FLORMIA_CAMPAIGN_STOPPED",
  cancelled: "FLORMIA_CAMPAIGN_CANCELLED",
  cancelRequest: "FLORMIA_CAMPAIGN_CANCEL_REQUEST",
  startRequest: "FLORMIA_CAMPAIGN_START",
  pauseRequest: "FLORMIA_CAMPAIGN_PAUSE",
  resumeRequest: "FLORMIA_CAMPAIGN_RESUME",
  retryRequest: "FLORMIA_CAMPAIGN_RETRY",
  retryFailedRequest: "FLORMIA_CAMPAIGN_RETRY_FAILED",
  stopRequest: "FLORMIA_CAMPAIGN_STOP",
  deleteRequest: "FLORMIA_CAMPAIGN_DELETE",
  statusRequest: "FLORMIA_CAMPAIGN_STATUS_REQUEST",
  diagnosticReportRequest: "FLORMIA_DIAGNOSTIC_REPORT_REQUEST",
  diagnosticReport: "FLORMIA_DIAGNOSTIC_REPORT",
  inboxGetChatsRequest: "FLORMIA_INBOX_GET_CHATS_REQUEST",
  inboxChats: "FLORMIA_INBOX_CHATS",
  inboxGetMessagesRequest: "FLORMIA_INBOX_GET_MESSAGES_REQUEST",
  inboxMessages: "FLORMIA_INBOX_MESSAGES",
  inboxSendTextRequest: "FLORMIA_INBOX_SEND_TEXT_REQUEST",
  inboxTextSent: "FLORMIA_INBOX_TEXT_SENT",
  inboxError: "FLORMIA_INBOX_ERROR"
} as const;

export type WebAppMessageType = (typeof WEB_APP_MESSAGE_TYPES)[keyof typeof WEB_APP_MESSAGE_TYPES];

export interface WebAppEnvelope {
  channel: typeof WEB_APP_CHANNEL;
  protocolVersion: typeof PROTOCOL_VERSION;
  type: WebAppMessageType;
  requestId?: string;
  replyTo?: string;
  campaignId?: string;
  sequence?: number;
  payload: Record<string, unknown>;
}

export interface FlorMiaExtensionStatus {
  operational: boolean;
  message: string;
  extensionVersion: string;
  manifestVersion: number;
  protocolVersion: number;
  configuredLimit: number;
  sentToday: number;
  availableToday: number;
  overallStatus: CompatibilityOverallStatus;
  campaign: CampaignPublicStatus | null;
  updatedAt: string;
  errorCode?: string;
  bridgeInstanceId?: string;
  bridgeGeneration?: number;
  bridgeCreatedAt?: string;
  runtimeAvailable?: boolean;
}

const webAppInboundTypes = new Set<string>([
  WEB_APP_MESSAGE_TYPES.ping,
  WEB_APP_MESSAGE_TYPES.preflightRequest,
  WEB_APP_MESSAGE_TYPES.prepare,
  WEB_APP_MESSAGE_TYPES.cancelRequest,
  WEB_APP_MESSAGE_TYPES.startRequest,
  WEB_APP_MESSAGE_TYPES.pauseRequest,
  WEB_APP_MESSAGE_TYPES.resumeRequest,
  WEB_APP_MESSAGE_TYPES.retryRequest,
  WEB_APP_MESSAGE_TYPES.retryFailedRequest,
  WEB_APP_MESSAGE_TYPES.stopRequest,
  WEB_APP_MESSAGE_TYPES.deleteRequest,
  WEB_APP_MESSAGE_TYPES.statusRequest,
  WEB_APP_MESSAGE_TYPES.diagnosticReportRequest,
  WEB_APP_MESSAGE_TYPES.inboxGetChatsRequest,
  WEB_APP_MESSAGE_TYPES.inboxGetMessagesRequest,
  WEB_APP_MESSAGE_TYPES.inboxSendTextRequest
]);

const webAppControlTypes = new Set<string>([
  WEB_APP_MESSAGE_TYPES.cancelRequest,
  WEB_APP_MESSAGE_TYPES.startRequest,
  WEB_APP_MESSAGE_TYPES.pauseRequest,
  WEB_APP_MESSAGE_TYPES.resumeRequest,
  WEB_APP_MESSAGE_TYPES.retryRequest,
  WEB_APP_MESSAGE_TYPES.retryFailedRequest,
  WEB_APP_MESSAGE_TYPES.stopRequest,
  WEB_APP_MESSAGE_TYPES.deleteRequest
]);

const FORBIDDEN_PRODUCTION_KEYS = new Set([
  "developmentFault",
  "faultInjection",
  "simulatedOffline",
  "selectorBreak",
  "compatibilityFault"
]);

function containsForbiddenProductionControl(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    if (value.length > 5_000) return true;
    return value.some((item) => containsForbiddenProductionControl(item, depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    FORBIDDEN_PRODUCTION_KEYS.has(key) || containsForbiddenProductionControl(child, depth + 1));
}

function campaignIdFromEnvelope(value: Record<string, unknown>): string {
  const payload = value.payload as Record<string, unknown>;
  const raw = value.campaignId ?? payload.campaignId;
  return typeof raw === "string" ? raw.trim() : "";
}

function isSerializedCampaignShape(payload: Record<string, unknown>): boolean {
  return typeof payload.campaignId === "string"
    && typeof payload.campaignName === "string"
    && typeof payload.createdBy === "string"
    && typeof payload.message === "string"
    && Array.isArray(payload.recipients)
    && payload.recipients.length > 0
    && payload.recipients.every((recipient) => isRecord(recipient)
      && typeof recipient.recipientId === "string"
      && typeof recipient.phone === "string"
      && (recipient.source === "flor_mia" || recipient.source === "excel"))
    && Array.isArray(payload.images)
    && payload.images.every((image) => isRecord(image) && typeof image.dataBase64 === "string")
    && Array.isArray(payload.imageOrder)
    && typeof payload.imageCount === "number"
    && typeof payload.totalRecipients === "number";
}

function validInboxPayload(type: unknown, payload: Record<string, unknown>): boolean {
  if (type === WEB_APP_MESSAGE_TYPES.inboxGetChatsRequest) {
    return payload.limit === undefined || (Number.isInteger(payload.limit) && Number(payload.limit) >= 1 && Number(payload.limit) <= 100);
  }
  if (type === WEB_APP_MESSAGE_TYPES.inboxGetMessagesRequest) {
    return typeof payload.chatId === "string"
      && payload.chatId.length > 0
      && payload.chatId.length <= 200
      && (payload.limit === undefined || (Number.isInteger(payload.limit) && Number(payload.limit) >= 1 && Number(payload.limit) <= 100));
  }
  if (type === WEB_APP_MESSAGE_TYPES.inboxSendTextRequest) {
    return typeof payload.chatId === "string"
      && payload.chatId.length > 0
      && payload.chatId.length <= 200
      && typeof payload.message === "string"
      && payload.message.trim().length > 0
      && payload.message.length <= 4_096;
  }
  return true;
}

export function isWebAppInboundEnvelope(value: unknown): value is WebAppEnvelope {
  if (!isRecord(value)) return false;
  const payload = value.payload;
  return value.channel === WEB_APP_CHANNEL
    && value.protocolVersion === PROTOCOL_VERSION
    && typeof value.type === "string"
    && webAppInboundTypes.has(value.type)
    && typeof value.requestId === "string"
    && value.requestId.length > 0
    && value.requestId.length <= 200
    && isRecord(payload)
    && (value.campaignId === undefined || (typeof value.campaignId === "string" && value.campaignId.trim().length > 0 && value.campaignId.length <= 200))
    && (value.sequence === undefined || (Number.isInteger(value.sequence) && Number(value.sequence) >= 0))
    && !containsForbiddenProductionControl(payload)
    && !(value.campaignId !== undefined && typeof payload.campaignId === "string" && value.campaignId !== payload.campaignId)
    && !(value.type === WEB_APP_MESSAGE_TYPES.prepare && !isSerializedCampaignShape(payload))
    && !(webAppControlTypes.has(value.type) && !campaignIdFromEnvelope(value))
    && validInboxPayload(value.type, payload);
}
