import type { MessageContactWorkflowState, MessageMatchMode } from "./add-contacts-by-message";
import type { WhatsAppLabelInfo } from "./types";

export const MESSAGE_CONTACT_CHANNEL = "flor_mia_add_contacts_by_message_v1";
export const MESSAGE_CONTACT_PROTOCOL_VERSION = 1;

export const MESSAGE_CONTACT_TYPES = {
  getState: "MESSAGE_CONTACT_GET_STATE",
  search: "MESSAGE_CONTACT_SEARCH",
  assign: "MESSAGE_CONTACT_ASSIGN",
  pause: "MESSAGE_CONTACT_PAUSE",
  resume: "MESSAGE_CONTACT_RESUME",
  cancel: "MESSAGE_CONTACT_CANCEL",
  refreshList: "MESSAGE_CONTACT_REFRESH_LIST",
  reset: "MESSAGE_CONTACT_RESET"
} as const;

export type MessageContactMessageType = (typeof MESSAGE_CONTACT_TYPES)[keyof typeof MESSAGE_CONTACT_TYPES];

export interface MessageContactRequestMap {
  MESSAGE_CONTACT_GET_STATE: Record<string, never>;
  MESSAGE_CONTACT_SEARCH: {
    targetLabel: WhatsAppLabelInfo;
    searchText: string;
    mode: MessageMatchMode;
    inboundOnly: boolean;
    excludeGroups: boolean;
    excludeCommunities: boolean;
    excludeChannels: boolean;
  };
  MESSAGE_CONTACT_ASSIGN: Record<string, never>;
  MESSAGE_CONTACT_PAUSE: Record<string, never>;
  MESSAGE_CONTACT_RESUME: Record<string, never>;
  MESSAGE_CONTACT_CANCEL: Record<string, never>;
  MESSAGE_CONTACT_REFRESH_LIST: Record<string, never>;
  MESSAGE_CONTACT_RESET: Record<string, never>;
}

export interface MessageContactResponseMap {
  MESSAGE_CONTACT_GET_STATE: MessageContactWorkflowState;
  MESSAGE_CONTACT_SEARCH: MessageContactWorkflowState;
  MESSAGE_CONTACT_ASSIGN: MessageContactWorkflowState;
  MESSAGE_CONTACT_PAUSE: MessageContactWorkflowState;
  MESSAGE_CONTACT_RESUME: MessageContactWorkflowState;
  MESSAGE_CONTACT_CANCEL: MessageContactWorkflowState;
  MESSAGE_CONTACT_REFRESH_LIST: MessageContactWorkflowState;
  MESSAGE_CONTACT_RESET: MessageContactWorkflowState;
}

export interface MessageContactEnvelope<T extends MessageContactMessageType = MessageContactMessageType> {
  channel: typeof MESSAGE_CONTACT_CHANNEL;
  protocolVersion: typeof MESSAGE_CONTACT_PROTOCOL_VERSION;
  requestId: string;
  source: "contact-export-page";
  type: T;
  payload: MessageContactRequestMap[T];
}

export interface MessageContactResponse<T> {
  ok: boolean;
  requestId: string;
  data?: T;
  error?: { code?: string; message: string; details?: Record<string, unknown> };
}

const types = new Set<string>(Object.values(MESSAGE_CONTACT_TYPES));

export function isMessageContactEnvelope(value: unknown): value is MessageContactEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.channel === MESSAGE_CONTACT_CHANNEL
    && record.protocolVersion === MESSAGE_CONTACT_PROTOCOL_VERSION
    && record.source === "contact-export-page"
    && typeof record.requestId === "string"
    && typeof record.type === "string"
    && types.has(record.type)
    && Boolean(record.payload)
    && typeof record.payload === "object"
    && !Array.isArray(record.payload);
}

export async function sendMessageContactRequest<T extends MessageContactMessageType>(
  type: T,
  payload: MessageContactRequestMap[T]
): Promise<MessageContactResponseMap[T]> {
  const requestId = globalThis.crypto?.randomUUID?.() ?? `message-contact-${Date.now()}`;
  const request: MessageContactEnvelope<T> = {
    channel: MESSAGE_CONTACT_CHANNEL,
    protocolVersion: MESSAGE_CONTACT_PROTOCOL_VERSION,
    requestId,
    source: "contact-export-page",
    type,
    payload
  };
  const response = await chrome.runtime.sendMessage(request) as MessageContactResponse<MessageContactResponseMap[T]> | undefined;
  if (!response) throw new Error("La extensión no respondió.");
  if (!response.ok || response.data === undefined) {
    const error = new Error(response.error?.message || "La operación no pudo completarse.");
    Object.assign(error, { code: response.error?.code, details: response.error?.details });
    throw error;
  }
  return response.data;
}
