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
  campaignStop: "CAMPAIGN_STOP",
  campaignStatus: "CAMPAIGN_STATUS",
  campaignRestoreImages: "CAMPAIGN_RESTORE_IMAGES",
  whatsappPreflight: "WA_PREFLIGHT",
  whatsappOpenConversation: "WA_OPEN_CONVERSATION",
  whatsappProveConversation: "WA_PROVE_CONVERSATION",
  whatsappSendText: "WA_SEND_TEXT",
  whatsappSendImage: "WA_SEND_IMAGE",
  whatsappReconcileStep: "WA_RECONCILE_STEP",
  whatsappOperationStage: "WA_OPERATION_STAGE",
  webAppPing: "WEB_APP_PING",
  webAppPrepareCampaign: "WEB_APP_PREPARE_CAMPAIGN",
  webAppCancelCampaign: "WEB_APP_CANCEL_CAMPAIGN"
} as const;

export type InternalMessageType = (typeof INTERNAL_MESSAGE_TYPES)[keyof typeof INTERNAL_MESSAGE_TYPES];
export type InternalSource = "popup" | "diagnostics-page" | "service-worker" | "whatsapp-content" | "web-app-bridge";

export interface InternalRequestMap {
  GET_EXTENSION_STATE: Record<string, never>;
  RUN_WHATSAPP_PREFLIGHT: { developmentFault?: CompatibilityDevelopmentFault };
  SET_COMPATIBILITY_DEVELOPMENT_FAULT: { fault: CompatibilityDevelopmentFault };
  GENERATE_DIAGNOSTIC_REPORT: { includeCampaignName?: boolean };
  SEND_TEST_TEXT: { phone: string; message: string };
  PROCESS_TEST_CONTACT: { phone: string; message: string; images: SerializedCampaignImage[]; faultInjection?: DevelopmentFault };
  RESUME_CONTACT_PROCESS: Record<string, never>;
  RESELECT_CONTACT_IMAGES: { campaignId: string; images: SerializedCampaignImage[] };
  CAMPAIGN_START: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_PAUSE: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_RESUME: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_STOP: { campaignId: string; expectedSequence?: number };
  CAMPAIGN_STATUS: { campaignId?: string };
  CAMPAIGN_RESTORE_IMAGES: { campaignId: string; images: SerializedCampaignImage[] };
  WA_PREFLIGHT: WhatsAppPreflightRequest;
  WA_OPEN_CONVERSATION: { operationId: string; phoneDigits: string };
  WA_PROVE_CONVERSATION: {
    operationId: string;
    phoneDigits: string;
    timeoutMs?: number;
    requestedNavigationAt?: string;
    navigationObservedAt?: string;
    expectedContentInstanceId?: string;
  };
  WA_SEND_TEXT: { operationId: string; phoneDigits: string; message: string; timeoutMs?: number; checkpointRequired?: boolean };
  WA_SEND_IMAGE: ImageSendInput;
  WA_RECONCILE_STEP: ReconcileStepInput;
  WA_OPERATION_STAGE: { operationId: string; stage: "send_attempted"; baselineOutgoingIds: string[] };
  WEB_APP_PING: Record<string, never>;
  WEB_APP_PREPARE_CAMPAIGN: SerializedCampaignPayload;
  WEB_APP_CANCEL_CAMPAIGN: { campaignId: string };
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
  CAMPAIGN_STOP: CampaignPublicStatus;
  CAMPAIGN_STATUS: CampaignPublicStatus | null;
  CAMPAIGN_RESTORE_IMAGES: CampaignPublicStatus;
  WA_PREFLIGHT: WhatsAppPreflightResult;
  WA_OPEN_CONVERSATION: { navigationStarted: true; requestedNavigationAt: string; contentInstanceId: string };
  WA_PROVE_CONVERSATION: ConversationContextProof;
  WA_SEND_TEXT: TextTestResult;
  WA_SEND_IMAGE: ImageSendResult;
  WA_RECONCILE_STEP: StepReconciliationResult;
  WA_OPERATION_STAGE: { recorded: boolean };
  WEB_APP_PING: FlorMiaExtensionStatus;
  WEB_APP_PREPARE_CAMPAIGN: CampaignPublicStatus;
  WEB_APP_CANCEL_CAMPAIGN: { campaignId: string; cancelledAt: string };
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
  stopRequest: "FLORMIA_CAMPAIGN_STOP",
  statusRequest: "FLORMIA_CAMPAIGN_STATUS_REQUEST"
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
}

const webAppInboundTypes = new Set<string>([
  WEB_APP_MESSAGE_TYPES.ping,
  WEB_APP_MESSAGE_TYPES.preflightRequest,
  WEB_APP_MESSAGE_TYPES.prepare,
  WEB_APP_MESSAGE_TYPES.cancelRequest,
  WEB_APP_MESSAGE_TYPES.startRequest,
  WEB_APP_MESSAGE_TYPES.pauseRequest,
  WEB_APP_MESSAGE_TYPES.resumeRequest,
  WEB_APP_MESSAGE_TYPES.stopRequest,
  WEB_APP_MESSAGE_TYPES.statusRequest
]);

const webAppControlTypes = new Set<string>([
  WEB_APP_MESSAGE_TYPES.cancelRequest,
  WEB_APP_MESSAGE_TYPES.startRequest,
  WEB_APP_MESSAGE_TYPES.pauseRequest,
  WEB_APP_MESSAGE_TYPES.resumeRequest,
  WEB_APP_MESSAGE_TYPES.stopRequest
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

export function isWebAppInboundEnvelope(value: unknown): value is WebAppEnvelope {
  if (!isRecord(value)) return false;
  return value.channel === WEB_APP_CHANNEL
    && value.protocolVersion === PROTOCOL_VERSION
    && typeof value.type === "string"
    && webAppInboundTypes.has(value.type)
    && typeof value.requestId === "string"
    && value.requestId.length > 0
    && value.requestId.length <= 200
    && isRecord(value.payload)
    && (value.campaignId === undefined || (typeof value.campaignId === "string" && value.campaignId.trim().length > 0 && value.campaignId.length <= 200))
    && (value.sequence === undefined || (Number.isInteger(value.sequence) && Number(value.sequence) >= 0))
    && !containsForbiddenProductionControl(value.payload)
    && !(value.campaignId !== undefined && typeof value.payload.campaignId === "string" && value.campaignId !== value.payload.campaignId)
    && !(value.type === WEB_APP_MESSAGE_TYPES.prepare && !isSerializedCampaignShape(value.payload))
    && !(webAppControlTypes.has(value.type) && !campaignIdFromEnvelope(value));
}
