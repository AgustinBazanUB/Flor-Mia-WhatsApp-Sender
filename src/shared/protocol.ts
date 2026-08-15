import type { SerializedCampaignPayload } from "./serialization";
import type { ExtensionState, TextTestResult, WhatsAppPreflightResult } from "./state";

export const INTERNAL_CHANNEL = "flor_mia_whatsapp_sender_internal";
export const WEB_APP_CHANNEL = "flor_mia_whatsapp_extension";
export const PROTOCOL_VERSION = 1;

export const INTERNAL_MESSAGE_TYPES = {
  getState: "GET_EXTENSION_STATE",
  runPreflight: "RUN_WHATSAPP_PREFLIGHT",
  sendTestText: "SEND_TEST_TEXT",
  whatsappPreflight: "WA_PREFLIGHT",
  whatsappOpenConversation: "WA_OPEN_CONVERSATION",
  whatsappSendText: "WA_SEND_TEXT",
  webAppPing: "WEB_APP_PING",
  webAppPrepareCampaign: "WEB_APP_PREPARE_CAMPAIGN",
  webAppCancelCampaign: "WEB_APP_CANCEL_CAMPAIGN"
} as const;

export type InternalMessageType = (typeof INTERNAL_MESSAGE_TYPES)[keyof typeof INTERNAL_MESSAGE_TYPES];
export type InternalSource = "popup" | "service-worker" | "whatsapp-content" | "web-app-bridge";

export interface InternalRequestMap {
  GET_EXTENSION_STATE: Record<string, never>;
  RUN_WHATSAPP_PREFLIGHT: Record<string, never>;
  SEND_TEST_TEXT: { phone: string; message: string };
  WA_PREFLIGHT: { timeoutMs?: number };
  WA_OPEN_CONVERSATION: { operationId: string; phoneDigits: string };
  WA_SEND_TEXT: { operationId: string; phoneDigits: string; message: string };
  WEB_APP_PING: Record<string, never>;
  WEB_APP_PREPARE_CAMPAIGN: SerializedCampaignPayload;
  WEB_APP_CANCEL_CAMPAIGN: { campaignId: string };
}

export interface InternalResponseMap {
  GET_EXTENSION_STATE: ExtensionState;
  RUN_WHATSAPP_PREFLIGHT: WhatsAppPreflightResult;
  SEND_TEST_TEXT: TextTestResult;
  WA_PREFLIGHT: WhatsAppPreflightResult;
  WA_OPEN_CONVERSATION: { navigationStarted: true };
  WA_SEND_TEXT: TextTestResult;
  WEB_APP_PING: { operational: boolean; message: string; extensionVersion: string; configuredLimit: number; sentToday: number; availableToday: number; errorCode?: string };
  WEB_APP_PREPARE_CAMPAIGN: { campaignId: string; acceptedAt: string };
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
    && ["popup", "service-worker", "whatsapp-content", "web-app-bridge"].includes(String(value.source))
    && typeof value.type === "string"
    && internalTypes.has(value.type)
    && isRecord(value.payload);
}

export async function sendRuntimeRequest<T extends InternalMessageType>(
  source: InternalSource,
  type: T,
  payload: InternalRequestMap[T]
): Promise<InternalResponseMap[T]> {
  const request = createInternalRequest(source, type, payload);
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
  status: "FLORMIA_EXTENSION_STATUS",
  prepare: "FLORMIA_CAMPAIGN_PREPARE",
  accepted: "FLORMIA_CAMPAIGN_ACCEPTED",
  started: "FLORMIA_CAMPAIGN_STARTED",
  progress: "FLORMIA_CAMPAIGN_PROGRESS",
  paused: "FLORMIA_CAMPAIGN_PAUSED",
  completed: "FLORMIA_CAMPAIGN_COMPLETED",
  error: "FLORMIA_CAMPAIGN_ERROR",
  cancelled: "FLORMIA_CAMPAIGN_CANCELLED",
  cancelRequest: "FLORMIA_CAMPAIGN_CANCEL_REQUEST"
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

const webAppInboundTypes = new Set<string>([
  WEB_APP_MESSAGE_TYPES.ping,
  WEB_APP_MESSAGE_TYPES.prepare,
  WEB_APP_MESSAGE_TYPES.cancelRequest
]);

export function isWebAppInboundEnvelope(value: unknown): value is WebAppEnvelope {
  if (!isRecord(value)) return false;
  if (value.channel !== WEB_APP_CHANNEL || value.protocolVersion !== PROTOCOL_VERSION) return false;
  if (typeof value.type !== "string" || !webAppInboundTypes.has(value.type)) return false;
  if (typeof value.requestId !== "string" || !value.requestId) return false;
  if (!isRecord(value.payload)) return false;
  if (value.campaignId !== undefined && typeof value.campaignId !== "string") return false;
  return true;
}
