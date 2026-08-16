import type { CampaignState, DailyLimitState } from "../campaign/campaign-types";
import { progressForCampaign } from "../campaign/progress";
import type { CandidateSummary } from "../compatibility/types";
import type { ContactProcessCheckpoint } from "../engine/types";
import type { SerializedExtensionError } from "../shared/errors";
import type {
  SanitizedCampaignReport,
  SanitizedCheckpointReport,
  SanitizedDailyLimit
} from "./types";

const REDACTED = "[REDACTED]";
const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/g;
const DATA_URL_PATTERN = /data:[^;,\s]+;base64,[a-z0-9+/=]+/gi;
const LONG_BASE64_PATTERN = /\b(?:[a-z0-9+/]{80,}={0,2})\b/gi;
const SENSITIVE_KEY_PARTS = new Set([
  "text", "body", "message", "conversation", "chat", "cookie", "token", "password", "credential", "secret", "qr",
  "html", "base64", "binary", "blob", "data"
]);
const SAFE_CANDIDATE_ARIA = /^(?:send|enviar|attach|adjuntar|close|cerrar|chat|message|mensaje|image|imagen|photo|foto|video|search|buscar|type|escribe)$/i;
const SAFE_STRUCTURAL_VALUE = /^[a-z0-9_.:-]{1,120}$/i;
const SAFE_HIERARCHY_HINT = /^(?:[a-z][a-z0-9-]*(?:\[(?:role|testid|icon)=[a-z0-9_.:-]+\])*)(?: > [a-z][a-z0-9-]*(?:\[(?:role|testid|icon)=[a-z0-9_.:-]+\])*){0,2}$/i;
const MAX_STRING_LENGTH = 500;

export interface DiagnosticSanitizerOptions {
  sensitiveStrings?: string[];
  maxStringLength?: number;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return normalized.split(/[^a-z0-9]+/).some((part) => SENSITIVE_KEY_PARTS.has(part));
}

function replaceSensitiveStrings(value: string, sensitiveStrings: string[]): string {
  return sensitiveStrings
    .filter((secret) => secret.length >= 3)
    .sort((a, b) => b.length - a.length)
    .reduce((current, secret) => current.split(secret).join("[REDACTED_MESSAGE]"), value);
}

function redactPhoneCandidates(value: string): string {
  return value.replace(PHONE_PATTERN, (candidate) => candidate.replace(/\D/g, "").length >= 10 ? "[REDACTED_PHONE]" : candidate);
}

export function sanitizeDiagnosticText(value: string, options: DiagnosticSanitizerOptions = {}): string {
  const withoutSecrets = replaceSensitiveStrings(value, options.sensitiveStrings ?? []);
  const withoutBinary = withoutSecrets
    .replace(DATA_URL_PATTERN, "[REDACTED_BASE64]")
    .replace(LONG_BASE64_PATTERN, "[REDACTED_BASE64]");
  const redacted = redactPhoneCandidates(withoutBinary);
  const max = options.maxStringLength ?? MAX_STRING_LENGTH;
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

export function sanitizeDiagnosticUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "chrome-extension:") return `chrome-extension://<extension>${parsed.pathname}`;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.origin}${parsed.pathname || "/"}`;
  } catch {
    return null;
  }
}

export function sanitizeStackTrace(stack: string | null | undefined, options: DiagnosticSanitizerOptions = {}): string | null {
  if (!stack) return null;
  const safeUrls = stack.replace(/(?:https?|chrome-extension):\/\/[^\s)]+/gi, (url) => sanitizeDiagnosticUrl(url) ?? "[REDACTED_URL]");
  const safePaths = safeUrls
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\/g, "<local>\\")
    .replace(/\/Users\/[^/\s]+\//g, "<local>/")
    .replace(/\/home\/[^/\s]+\//g, "<local>/");
  return sanitizeDiagnosticText(safePaths, { ...options, maxStringLength: 4_000 });
}

export function sanitizeDiagnosticValue(
  value: unknown,
  key = "",
  options: DiagnosticSanitizerOptions = {},
  depth = 0
): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return sanitizeDiagnosticText(value, options);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeDiagnosticValue(item, "", options, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([childKey, childValue]) => [childKey, sanitizeDiagnosticValue(childValue, childKey, options, depth + 1)]));
  }
  return String(value);
}

export function sanitizeCandidate(value: unknown): CandidateSummary {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const aria = typeof candidate.ariaLabel === "string"
    ? sanitizeDiagnosticText(candidate.ariaLabel, { maxStringLength: 80 })
    : undefined;
  const safeAria = aria && SAFE_CANDIDATE_ARIA.test(aria) && !aria.includes("[REDACTED_PHONE]") ? aria : aria ? REDACTED : undefined;
  const safe = (key: string, maxStringLength = 120): string | undefined => {
    if (typeof candidate[key] !== "string") return undefined;
    const sanitized = sanitizeDiagnosticText(candidate[key] as string, { maxStringLength });
    return SAFE_STRUCTURAL_VALUE.test(sanitized) ? sanitized : REDACTED;
  };
  const hierarchy = typeof candidate.hierarchyHint === "string"
    ? sanitizeDiagnosticText(candidate.hierarchyHint, { maxStringLength: 160 })
    : undefined;
  return {
    tagName: safe("tagName", 40) ?? "unknown",
    ...(safe("role", 60) ? { role: safe("role", 60) } : {}),
    ...(safeAria ? { ariaLabel: safeAria } : {}),
    ...(safe("dataTestId") ? { dataTestId: safe("dataTestId") } : {}),
    ...(safe("dataIcon") ? { dataIcon: safe("dataIcon") } : {}),
    ...(safe("type", 60) ? { type: safe("type", 60) } : {}),
    ...(safe("contentEditable", 20) ? { contentEditable: safe("contentEditable", 20) } : {}),
    ...(hierarchy ? { hierarchyHint: SAFE_HIERARCHY_HINT.test(hierarchy) ? hierarchy : REDACTED } : {})
  };
}

export function sanitizeError(
  error: SerializedExtensionError | null | undefined,
  options: DiagnosticSanitizerOptions = {}
): SerializedExtensionError | null {
  if (!error) return null;
  const stack = sanitizeStackTrace(error.stack, options);
  return {
    code: error.code,
    message: sanitizeDiagnosticText(error.message, options),
    recoverable: error.recoverable,
    ...(error.details ? { details: sanitizeDiagnosticValue(error.details, "details", options) as Record<string, unknown> } : {}),
    ...(stack ? { stack } : {})
  };
}

export function sanitizeDailyLimit(state: DailyLimitState): SanitizedDailyLimit {
  return {
    localDate: state.localDate,
    completedToday: state.completedToday,
    limit: state.limit,
    remaining: state.remaining,
    countedContacts: state.countedContactKeys.length,
    updatedAt: state.updatedAt
  };
}

export function sanitizeCampaignForReport(
  campaign: CampaignState | null,
  options: { includeCampaignName?: boolean } = {}
): SanitizedCampaignReport | null {
  if (!campaign) return null;
  const active = campaign.activeContactId
    ? campaign.recipients.find((recipient) => recipient.recipientId === campaign.activeContactId) ?? null
    : campaign.currentRecipientIndex === null ? null : campaign.recipients[campaign.currentRecipientIndex] ?? null;
  const sensitiveStrings = [campaign.text];
  return {
    campaignId: sanitizeDiagnosticText(campaign.campaignId, { maxStringLength: 160 }),
    campaignName: options.includeCampaignName ? sanitizeDiagnosticText(campaign.campaignName, { sensitiveStrings: [campaign.text], maxStringLength: 160 }) : null,
    status: campaign.status,
    totalRecipients: campaign.recipients.length,
    completedRecipients: campaign.completedRecipients,
    progress: progressForCampaign(campaign),
    activeRecipient: active ? {
      recipientInternalId: sanitizeDiagnosticText(active.recipientId, { maxStringLength: 160 }),
      position: active.position,
      maskedPhone: sanitizeDiagnosticText(active.maskedPhone, { maxStringLength: 40 }),
      status: active.status
    } : null,
    messageMetadata: { length: campaign.text.length, localFingerprint: null },
    images: campaign.images.map((image) => ({ order: image.order, type: sanitizeDiagnosticText(image.type, { maxStringLength: 80 }), size: image.size })),
    dailyLimit: sanitizeDailyLimit(campaign.dailyLimit),
    blockReason: campaign.blockReason ? {
      code: campaign.blockReason.code,
      message: sanitizeDiagnosticText(campaign.blockReason.message, { sensitiveStrings }),
      recoverable: campaign.blockReason.recoverable,
      at: campaign.blockReason.at
    } : null
  };
}

export function sanitizeCheckpointForReport(
  checkpoint: ContactProcessCheckpoint | null,
  sensitiveStrings: string[] = []
): SanitizedCheckpointReport | null {
  if (!checkpoint) return null;
  return {
    schemaVersion: checkpoint.schemaVersion,
    checkpointId: sanitizeDiagnosticText(checkpoint.checkpointId, { maxStringLength: 160 }),
    campaignId: sanitizeDiagnosticText(checkpoint.campaignId, { maxStringLength: 160 }),
    contact: {
      recipientInternalId: sanitizeDiagnosticText(checkpoint.contact.contactId, { maxStringLength: 160 }),
      maskedPhone: sanitizeDiagnosticText(checkpoint.contact.maskedPhone, { maxStringLength: 40 })
    },
    status: checkpoint.status,
    currentStepId: checkpoint.currentStepId,
    lastConfirmedStepId: checkpoint.lastConfirmedStepId,
    openConversationAttempts: checkpoint.openConversationAttempts,
    pauseReason: checkpoint.pauseReason ?? null,
    error: sanitizeError(checkpoint.error, { sensitiveStrings }),
    steps: checkpoint.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      status: step.status,
      attempts: step.attempts,
      imageOrder: step.kind === "image" ? step.image.order : null,
      startedAt: step.startedAt ?? null,
      completedAt: step.completedAt ?? null,
      verification: step.verification ? {
        outcome: step.verification.outcome,
        method: sanitizeDiagnosticText(step.verification.method, { maxStringLength: 160 }),
        sendAttempted: step.verification.sendAttempted
      } : null,
      error: sanitizeError(step.error, { sensitiveStrings })
    })),
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt
  };
}
