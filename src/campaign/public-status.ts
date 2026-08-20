import type { ContactProcessCheckpoint } from "../engine/types";
import type { CampaignPublicStatus, CampaignState } from "./campaign-types";
import { campaignRecipientCounters, progressForCampaign } from "./progress";
import type { CompatibilityOverallStatus } from "../compatibility/types";
import { classifyDiagnosticError } from "../diagnostics/taxonomy";

export interface CampaignPublicStatusOptions {
  extensionVersion: string;
  redGreen: CompatibilityOverallStatus;
  includeRecipientName?: boolean;
}

function durationBetween(startedAt: string, completedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

export function toCampaignPublicStatus(
  campaign: CampaignState,
  checkpoint: ContactProcessCheckpoint | null,
  options: CampaignPublicStatusOptions = { extensionVersion: "unknown", redGreen: "RED" }
): CampaignPublicStatus {
  const recipient = campaign.activeContactId
    ? campaign.recipients.find((item) => item.recipientId === campaign.activeContactId) ?? null
    : campaign.currentRecipientIndex === null
      ? null
      : campaign.recipients[campaign.currentRecipientIndex] ?? null;
  const progress = progressForCampaign(campaign);
  const counters = campaignRecipientCounters(campaign);
  const terminalAt = campaign.completedAt ?? campaign.stoppedAt ?? campaign.cancelledAt ?? null;
  const startedAt = campaign.startedAt ?? campaign.createdAt;
  const error = campaign.blockReason?.error ?? null;
  const errorSummary = campaign.blockReason ? {
    code: error?.code ?? null,
    category: classifyDiagnosticError(error, { campaignBlockCode: campaign.blockReason.code }),
    message: campaign.blockReason.message,
    recoverable: campaign.blockReason.recoverable
  } : null;
  const terminalStatus = ["completed", "stopped", "cancelled"].includes(campaign.status)
    ? campaign.status as "completed" | "stopped" | "cancelled"
    : null;
  const cancellationEvidence = checkpoint?.campaignId === campaign.campaignId
    ? (() => {
        const step = [...checkpoint.steps].reverse().find((item) => item.verification?.sendAttempted === true);
        if (!step) return null;
        return {
          stepId: step.id,
          operationId: step.operationId,
          sendAttempted: true,
          verificationOutcome: step.verification?.outcome ?? null,
          observedAt: step.verification?.observedAt ?? null,
          errorCategory: step.error ? classifyDiagnosticError(step.error) : null,
          maskedPhone: checkpoint.contact.maskedPhone
        };
      })()
    : null;
  const finalSummary = terminalStatus && terminalAt ? {
    campaignId: campaign.campaignId,
    terminalStatus,
    completedAt: terminalAt,
    total: counters.total,
    processed: counters.processed,
    sent: counters.sent,
    confirmedSent: counters.confirmedSent,
    unverifiedSent: counters.unverifiedSent,
    failed: counters.failed,
    durationMs: durationBetween(startedAt, terminalAt),
    batches: campaign.batchNumber,
    sentToday: campaign.dailyLimit.completedToday,
    extensionVersion: options.extensionVersion,
    lastCompletedContactId: campaign.lastCompletedContactId,
    cancellationEvidence
  } : null;
  return {
    snapshotSchemaVersion: 1,
    campaignId: campaign.campaignId,
    campaignName: campaign.campaignName,
    receivedAt: campaign.receivedAt,
    acceptedAt: campaign.receivedAt,
    status: campaign.status,
    progress,
    progressPercentage: progress.percentage,
    processed: counters.processed,
    sent: counters.sent,
    confirmedSent: counters.confirmedSent,
    unverifiedSent: counters.unverifiedSent,
    failed: counters.failed,
    total: counters.total,
    remaining: counters.remaining,
    currentRecipientIndex: campaign.currentRecipientIndex,
    currentRecipientId: recipient?.recipientId ?? null,
    ...(options.includeRecipientName && recipient?.name ? { currentRecipientName: recipient.name } : {}),
    maskedPhone: recipient?.maskedPhone ?? null,
    currentStep: checkpoint?.campaignId === campaign.campaignId ? checkpoint.currentStepId : campaign.wait?.kind ?? null,
    batch: {
      number: campaign.batchNumber,
      completedInBatch: campaign.contactsCompletedInBatch,
      size: campaign.policy.contactsPerBatch
    },
    sentToday: campaign.dailyLimit.completedToday,
    availableToday: campaign.dailyLimit.remaining,
    dailyLimitValue: campaign.dailyLimit.limit,
    errorSummary,
    redGreen: options.redGreen,
    updatedAt: campaign.updatedAt,
    extensionVersion: options.extensionVersion,
    currentContact: recipient ? {
      position: recipient.position,
      total: campaign.recipients.length,
      ...(options.includeRecipientName && recipient.name ? { name: recipient.name } : {}),
      maskedPhone: recipient.maskedPhone
    } : null,
    currentStepId: checkpoint?.campaignId === campaign.campaignId ? checkpoint.currentStepId : null,
    lastConfirmedStepId: checkpoint?.campaignId === campaign.campaignId ? checkpoint.lastConfirmedStepId : null,
    wait: campaign.wait,
    dailyLimit: {
      localDate: campaign.dailyLimit.localDate,
      completedToday: campaign.dailyLimit.completedToday,
      limit: campaign.dailyLimit.limit,
      remaining: campaign.dailyLimit.remaining,
      countedContacts: campaign.dailyLimit.countedContactKeys.length,
      updatedAt: campaign.dailyLimit.updatedAt
    },
    blockReason: campaign.blockReason,
    pauseRequested: campaign.pauseRequested,
    stopRequested: campaign.stopRequested,
    cancelRequested: campaign.cancelRequested,
    sequence: campaign.sequence,
    retryCycle: campaign.retryCycle ?? 0,
    retryableFailed: campaign.recipients.filter((item) => item.status === "error" && item.failure?.retryEligible === true && item.failure.ambiguous !== true).length,
    finalSummary
  };
}
