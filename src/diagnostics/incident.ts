import type { CampaignState } from "../campaign/campaign-types";
import type { CompatibilityState, WhatsAppCapability } from "../compatibility/types";
import type { ContactProcessCheckpoint } from "../engine/types";
import { ERROR_CODES } from "../shared/errors";
import type { ExtensionState } from "../shared/state";
import { sanitizeDiagnosticText, sanitizeError } from "./sanitizer";
import { classifyDiagnosticError } from "./taxonomy";
import type { DiagnosticIncident } from "./types";

export interface DiagnosticIncidentInput {
  state: ExtensionState;
  campaign: CampaignState | null;
  checkpoint: ContactProcessCheckpoint | null;
  compatibility: CompatibilityState;
  online?: boolean | null;
  includeCampaignName?: boolean;
  source?: DiagnosticIncident["source"];
}

const INCIDENT_CAMPAIGN_STATUSES = new Set<CampaignState["status"]>([
  "pause_requested",
  "paused",
  "daily_limit_reached",
  "images_required",
  "error",
  "stopped"
]);

function diagnosticCapability(error: unknown): WhatsAppCapability | null {
  if (!error || typeof error !== "object") return null;
  const details = (error as { details?: Record<string, unknown> }).details;
  const raw = (details?.compatibilityDiagnostic as Record<string, unknown> | undefined)?.capability;
  return typeof raw === "string" ? raw as WhatsAppCapability : null;
}

export function createDiagnosticIncident(input: DiagnosticIncidentInput): DiagnosticIncident | null {
  const { state, campaign, checkpoint, compatibility } = input;
  const shouldCreate = state.status === "error"
    || Boolean(campaign && INCIDENT_CAMPAIGN_STATUSES.has(campaign.status))
    || Boolean(checkpoint && ["paused", "images_required", "failed"].includes(checkpoint.status))
    || Boolean(compatibility.lastFailure);
  if (!shouldCreate) return null;

  const currentStep = checkpoint?.steps.find((step) => step.id === checkpoint.currentStepId) ?? null;
  const campaignRecipient = campaign
    ? checkpoint
      ? campaign.recipients.find((recipient) => recipient.recipientId === checkpoint.contact.contactId) ?? null
      : campaign.activeContactId
        ? campaign.recipients.find((recipient) => recipient.recipientId === campaign.activeContactId) ?? null
        : campaign.currentRecipientIndex === null ? null : campaign.recipients[campaign.currentRecipientIndex] ?? null
    : null;
  const latestStoredError = state.errors.at(-1) ?? null;
  const rawError = currentStep?.error ?? checkpoint?.error ?? campaign?.blockReason?.error ?? latestStoredError;
  const sensitiveStrings = campaign?.text ? [campaign.text] : [];
  const error = sanitizeError(rawError, { sensitiveStrings });
  const failure = compatibility.lastFailure;
  const source = input.source ?? (checkpoint ? "contact" : campaign ? "campaign" : failure ? "preflight" : "service_worker");
  const category = classifyDiagnosticError(error, {
    online: input.online,
    campaignBlockCode: campaign?.status === "stopped" ? "stopped" : campaign?.blockReason?.code,
    pauseReason: checkpoint?.pauseReason
  });
  // Compatibility history is useful context, but it must not become the cause of a
  // navigation/recipient-proof incident merely because a previous preflight failed.
  const capability = category === "WHATSAPP_UI_CHANGED"
    ? (diagnosticCapability(rawError) ?? (source === "preflight" ? failure?.capability ?? null : null))
    : null;
  const occurredAt = campaign?.blockReason?.at
    ?? checkpoint?.updatedAt
    ?? (source === "preflight" ? failure?.timestamp : undefined)
    ?? latestStoredError?.at
    ?? state.updatedAt;
  const recipientId = checkpoint?.contact.contactId ?? campaignRecipient?.recipientId ?? null;
  const stepId = checkpoint?.currentStepId ?? (source === "preflight" ? failure?.stepId ?? null : null);
  const campaignStatus = campaign?.status ?? null;
  const disposition: DiagnosticIncident["disposition"] = campaignStatus === "stopped"
    ? "stopped"
    : campaignStatus === "error" || checkpoint?.status === "failed" || state.status === "error"
      ? "error"
      : campaignStatus === "daily_limit_reached" || campaignStatus === "images_required"
        ? "blocked"
        : "paused";
  const contextFailure = error?.code === ERROR_CODES.contactContextUnverified
    || checkpoint?.pauseReason === "open_conversation_failed";
  const actionAttempted = currentStep
    ? currentStep.kind === "image" ? "send_image" : "send_text"
    : contextFailure ? "openConversation" : null;
  const attempts = currentStep?.attempts
    ?? (contextFailure ? checkpoint?.openConversationAttempts ?? null : null)
    ?? (source === "preflight" ? failure?.attempts ?? null : null);
  const resultSummary = sanitizeDiagnosticText(
    campaign?.blockReason?.message
      ?? error?.message
      ?? (checkpoint ? `El contacto quedó ${checkpoint.status}.` : "La extensión registró un incidente técnico."),
    { sensitiveStrings, maxStringLength: 300 }
  );
  return {
    incidentSchemaVersion: 1,
    incidentId: [campaign?.campaignId ?? checkpoint?.campaignId ?? "extension", recipientId ?? "none", stepId ?? "none", occurredAt].join(":"),
    occurredAt,
    source,
    disposition,
    campaignId: campaign?.campaignId ?? checkpoint?.campaignId ?? (source === "preflight" ? failure?.campaignId ?? null : null),
    campaignName: input.includeCampaignName && campaign ? sanitizeDiagnosticText(campaign.campaignName, { maxStringLength: 160 }) : null,
    campaignStatus,
    recipientInternalId: recipientId,
    recipientPosition: campaignRecipient?.position ?? null,
    totalRecipients: campaign?.recipients.length ?? null,
    contactStatus: campaignRecipient?.status ?? checkpoint?.status ?? null,
    maskedPhone: checkpoint?.contact.maskedPhone ?? campaignRecipient?.maskedPhone ?? (source === "preflight" ? failure?.maskedContact ?? null : null),
    stepId,
    stepKind: currentStep?.kind ?? null,
    imageOrder: currentStep?.kind === "image" ? currentStep.image.order : null,
    attempts,
    actionAttempted,
    resultSummary,
    lastConfirmedStepId: checkpoint?.lastConfirmedStepId ?? null,
    overallStatus: compatibility.overallStatus,
    errorCategory: category,
    error,
    capability,
    lastSuccessfulCapability: capability ? failure?.lastSuccessfulCapability ?? null : null,
    pauseReason: checkpoint?.pauseReason ?? campaign?.blockReason?.code ?? null
  };
}
