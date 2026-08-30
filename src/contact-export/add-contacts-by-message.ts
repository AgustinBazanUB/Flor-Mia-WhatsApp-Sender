import { canonicalExportPhoneKey, normalizeWhatsAppJidPhone } from "./phone-normalizer";
import type { ContactKind, WhatsAppLabelInfo } from "./types";

export const MESSAGE_CONTACT_ERROR_CODES = {
  globalSearchNotAvailable: "GLOBAL_SEARCH_NOT_AVAILABLE",
  searchResultsNotFound: "SEARCH_RESULTS_NOT_FOUND",
  searchResultParseFailed: "SEARCH_RESULT_PARSE_FAILED",
  messageDirectionUnknown: "MESSAGE_DIRECTION_UNKNOWN",
  messageDoesNotMatch: "MESSAGE_DOES_NOT_MATCH",
  contactIdUnresolved: "CONTACT_ID_UNRESOLVED",
  duplicateContact: "DUPLICATE_CONTACT",
  listMembershipCheckFailed: "LIST_MEMBERSHIP_CHECK_FAILED",
  listAssignmentFailed: "LIST_ASSIGNMENT_FAILED",
  listAssignmentNotConfirmed: "LIST_ASSIGNMENT_NOT_CONFIRMED",
  searchVirtualListStalled: "SEARCH_VIRTUAL_LIST_STALLED",
  whatsappStructureChanged: "WHATSAPP_STRUCTURE_CHANGED",
  cancelled: "ADD_CONTACTS_BY_MESSAGE_CANCELLED"
} as const;

export type MessageContactErrorCode = (typeof MESSAGE_CONTACT_ERROR_CODES)[keyof typeof MESSAGE_CONTACT_ERROR_CODES];
export type MessageMatchMode = "contains" | "exact";
export type MessageContactPreviewStatus = "NEW" | "ALREADY_IN_LIST" | "UNRESOLVED";
export type MessageContactAssignmentStatus = "PENDING" | "ADDING" | "ADDED" | "ALREADY_IN_LIST" | "FAILED";
export type MessageContactWorkflowStatus =
  | "idle"
  | "searching"
  | "preview"
  | "assigning"
  | "pausing"
  | "paused"
  | "completed"
  | "cancelled"
  | "error";

export interface MessageSearchOptions {
  searchText: string;
  mode: MessageMatchMode;
  inboundOnly: boolean;
  excludeGroups: boolean;
  excludeCommunities: boolean;
  excludeChannels: boolean;
}

export interface RawMessageSearchResult {
  messageId: string;
  chatId: string | null;
  contactId: string | null;
  phoneCandidate: string | null;
  name: string;
  messageText: string;
  fromMe: boolean | null;
  kind: ContactKind;
  alreadyInList: boolean;
  strategy: string;
}

export interface MessageSearchMetrics {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  searchPages: number;
  messagesScanned: number;
  messagesMatched: number;
  directionUnknown: number;
  excludedNonContacts: number;
  chatsOpened: number;
  visualOperations: number;
}

export interface MessageSearchMainWorldSnapshot {
  supported: boolean;
  reason: string | null;
  targetLabelInternalId: string | null;
  targetLabelMemberCount: number | null;
  results: RawMessageSearchResult[];
  metrics: MessageSearchMetrics;
}

export interface MessageContactPreviewItem {
  id: string;
  identityKey: string;
  chatId: string;
  contactId: string | null;
  phone: string;
  phoneDigits: string;
  name: string;
  matchingText: string;
  status: MessageContactPreviewStatus;
  assignmentStatus: MessageContactAssignmentStatus;
  attempts: number;
  errorCode: MessageContactErrorCode | null;
  errorMessage: string | null;
  sourceMessageCount: number;
  strategy: string;
}

export interface MessageContactSummary {
  messagesFound: number;
  uniqueContacts: number;
  alreadyInList: number;
  newContacts: number;
  unresolved: number;
  added: number;
  failed: number;
}

export interface MessageContactProgress {
  completed: number;
  total: number;
  percent: number;
  currentItemId: string | null;
  currentName: string | null;
  statusText: string;
}

export interface MessageContactDiagnostic {
  status: "unknown" | "green" | "red";
  currentStep: string | null;
  lastSuccessfulStep: string | null;
  failedStep: string | null;
  lastSuccessfulContactId: string | null;
  errorCode: MessageContactErrorCode | null;
  errorMessage: string | null;
  strategy: string | null;
  updatedAt: string;
}

export interface MessageContactWorkflowState {
  schemaVersion: 1;
  status: MessageContactWorkflowStatus;
  operationId: string | null;
  targetLabel: WhatsAppLabelInfo | null;
  targetContactCountBefore: number | null;
  targetContactCountAfter: number | null;
  search: MessageSearchOptions;
  items: MessageContactPreviewItem[];
  summary: MessageContactSummary;
  progress: MessageContactProgress | null;
  metrics: MessageSearchMetrics | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  diagnostic: MessageContactDiagnostic;
  updatedAt: string;
}

function opaqueId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `msg_${hash.toString(36).padStart(7, "0")}`;
}

export function normalizeMatchText(value: string | null | undefined): string {
  return String(value ?? "").normalize("NFC").trim();
}

export function matchesSearchRule(messageText: string, searchText: string, mode: MessageMatchMode): boolean {
  const message = normalizeMatchText(messageText);
  const search = normalizeMatchText(searchText);
  if (!search) return false;
  return mode === "exact" ? message === search : message.includes(search);
}

function phoneFromCandidate(value: string | null): { phone: string; digits: string } | null {
  const jid = normalizeWhatsAppJidPhone(value);
  if (jid) return { phone: jid.e164, digits: jid.digits };
  const key = canonicalExportPhoneKey(value);
  return key ? { phone: `+${key}`, digits: key } : null;
}

function isExcludedKind(kind: ContactKind, options: MessageSearchOptions): boolean {
  if (kind === "status" || kind === "system") return true;
  if (kind === "group" && options.excludeGroups) return true;
  if (kind === "community" && options.excludeCommunities) return true;
  if (kind === "channel" && options.excludeChannels) return true;
  return false;
}

function identityFor(result: RawMessageSearchResult): { key: string; phone: string; digits: string } | null {
  const normalizedPhone = phoneFromCandidate(result.phoneCandidate);
  if (normalizedPhone) return { key: `phone:${normalizedPhone.digits}`, phone: normalizedPhone.phone, digits: normalizedPhone.digits };
  const contactId = String(result.contactId ?? "").trim().toLocaleLowerCase("en-US");
  if (contactId) return { key: `contact:${contactId}`, phone: "", digits: "" };
  const chatId = String(result.chatId ?? "").trim().toLocaleLowerCase("en-US");
  if (chatId) return { key: `chat:${chatId}`, phone: "", digits: "" };
  return null;
}

export interface BuildMessagePreviewResult {
  items: MessageContactPreviewItem[];
  summary: MessageContactSummary;
  directionUnknown: number;
  excludedNonContacts: number;
  nonMatching: number;
  duplicatesRemoved: number;
}

export function buildMessageContactPreview(
  results: RawMessageSearchResult[],
  options: MessageSearchOptions
): BuildMessagePreviewResult {
  const byIdentity = new Map<string, MessageContactPreviewItem>();
  let directionUnknown = 0;
  let excludedNonContacts = 0;
  let nonMatching = 0;
  let duplicatesRemoved = 0;

  for (const result of results) {
    if (!matchesSearchRule(result.messageText, options.searchText, options.mode)) {
      nonMatching += 1;
      continue;
    }
    if (options.inboundOnly) {
      if (result.fromMe === true) continue;
      if (result.fromMe !== false) {
        directionUnknown += 1;
        continue;
      }
    }
    if (isExcludedKind(result.kind, options) || (result.kind !== "contact" && result.kind !== "unknown")) {
      excludedNonContacts += 1;
      continue;
    }
    const identity = identityFor(result);
    if (!identity || !result.chatId) {
      continue;
    }
    const existing = byIdentity.get(identity.key);
    if (existing) {
      existing.sourceMessageCount += 1;
      if (result.alreadyInList) {
        existing.status = "ALREADY_IN_LIST";
        existing.assignmentStatus = "ALREADY_IN_LIST";
      }
      if (!existing.phone && identity.phone) {
        existing.phone = identity.phone;
        existing.phoneDigits = identity.digits;
      }
      if (!existing.name && result.name) existing.name = result.name;
      duplicatesRemoved += 1;
      continue;
    }
    const resolved = Boolean(identity.phone || result.contactId || result.chatId);
    const status: MessageContactPreviewStatus = !resolved
      ? "UNRESOLVED"
      : result.alreadyInList
        ? "ALREADY_IN_LIST"
        : "NEW";
    byIdentity.set(identity.key, {
      id: opaqueId(identity.key),
      identityKey: identity.key,
      chatId: result.chatId,
      contactId: result.contactId,
      phone: identity.phone,
      phoneDigits: identity.digits,
      name: result.name.trim().slice(0, 160),
      matchingText: normalizeMatchText(result.messageText).slice(0, 500),
      status,
      assignmentStatus: status === "ALREADY_IN_LIST" ? "ALREADY_IN_LIST" : status === "NEW" ? "PENDING" : "FAILED",
      attempts: 0,
      errorCode: status === "UNRESOLVED" ? MESSAGE_CONTACT_ERROR_CODES.contactIdUnresolved : null,
      errorMessage: status === "UNRESOLVED" ? "No se pudo obtener una identidad de conversación confiable." : null,
      sourceMessageCount: 1,
      strategy: result.strategy
    });
  }

  const items = [...byIdentity.values()];
  const alreadyInList = items.filter((item) => item.status === "ALREADY_IN_LIST").length;
  const newContacts = items.filter((item) => item.status === "NEW").length;
  const unresolved = items.filter((item) => item.status === "UNRESOLVED").length;
  return {
    items,
    summary: {
      messagesFound: results.filter((result) => matchesSearchRule(result.messageText, options.searchText, options.mode)).length,
      uniqueContacts: items.length,
      alreadyInList,
      newContacts,
      unresolved,
      added: 0,
      failed: unresolved
    },
    directionUnknown,
    excludedNonContacts,
    nonMatching,
    duplicatesRemoved
  };
}

export function recomputeMessageContactSummary(
  items: MessageContactPreviewItem[],
  messagesFound: number
): MessageContactSummary {
  return {
    messagesFound,
    uniqueContacts: items.length,
    alreadyInList: items.filter((item) => item.assignmentStatus === "ALREADY_IN_LIST").length,
    newContacts: items.filter((item) => ["PENDING", "ADDING", "ADDED", "FAILED"].includes(item.assignmentStatus) && item.status === "NEW").length,
    unresolved: items.filter((item) => item.status === "UNRESOLVED").length,
    added: items.filter((item) => item.assignmentStatus === "ADDED").length,
    failed: items.filter((item) => item.assignmentStatus === "FAILED").length
  };
}

export function calculateMessageContactProgress(items: MessageContactPreviewItem[]): MessageContactProgress {
  const actionable = items.filter((item) => item.status === "NEW");
  const completed = actionable.filter((item) => ["ADDED", "FAILED"].includes(item.assignmentStatus)).length;
  const total = actionable.length;
  const current = actionable.find((item) => item.assignmentStatus === "ADDING") ?? null;
  return {
    completed,
    total,
    percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 100,
    currentItemId: current?.id ?? null,
    currentName: current?.name || null,
    statusText: current ? "Agregando a la lista…" : completed >= total ? "Proceso finalizado." : "Pendiente."
  };
}

export function pendingMessageContactItems(items: MessageContactPreviewItem[]): MessageContactPreviewItem[] {
  return items.filter((item) => item.status === "NEW" && item.assignmentStatus === "PENDING");
}
