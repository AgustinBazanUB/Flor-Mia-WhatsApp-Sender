import { COMPATIBILITY_ERROR_CODES } from "../compatibility/diagnostic-error";
import { classifyDiagnosticError } from "../diagnostics/taxonomy";
import { hasUnresolvedSendEvidence } from "../engine/checkpoint-safety";
import type { ContactProcessCheckpoint, ContactStep } from "../engine/types";
import { ERROR_CODES, type SerializedExtensionError } from "../shared/errors";
import type { CampaignRecipientFailure } from "./campaign-types";

export const LOCAL_FAILURE_CIRCUIT_THRESHOLD = 3;

export type CampaignContactFailureClass =
  | "local_safe"
  | "systemic"
  | "ambiguous"
  | "partial_send"
  | "images_required"
  | "manual_pause";

const SYSTEMIC_ERROR_CODES = new Set<string>([
  ERROR_CODES.whatsappNotOpen,
  ERROR_CODES.sessionNotReady,
  ERROR_CODES.attachmentUnavailable,
  ERROR_CODES.imageMissing,
  ERROR_CODES.capabilityUnavailable,
  ERROR_CODES.whatsappUiChanged,
  ERROR_CODES.selectorStrategyExhausted,
  ERROR_CODES.preflightFailed,
  ERROR_CODES.protocolError,
  ERROR_CODES.storageError,
  ERROR_CODES.internal
]);

const LOCAL_SAFE_ERROR_CODES = new Set<string>([
  ERROR_CODES.invalidContact,
  ERROR_CODES.contactUnavailable,
  ERROR_CODES.contactContextUnverified,
  ERROR_CODES.elementNotFound,
  ERROR_CODES.interfaceLoading,
  ERROR_CODES.timeout,
  ERROR_CODES.verificationFailed,
  ERROR_CODES.imageLoadFailed,
  ERROR_CODES.previewUnavailable,
  ERROR_CODES.retryLimit,
  ERROR_CODES.invalidInput
]);

export function checkpointStep(checkpoint: ContactProcessCheckpoint): ContactStep | undefined {
  return checkpoint.steps.find((step) => step.id === checkpoint.currentStepId)
    ?? checkpoint.steps.find((step) => step.error)
    ?? checkpoint.steps.find((step) => !["confirmed"].includes(step.status));
}

export function checkpointTechnicalError(checkpoint: ContactProcessCheckpoint): SerializedExtensionError | undefined {
  return checkpoint.error ?? checkpointStep(checkpoint)?.error;
}

export function checkpointHasAnySendAttempt(checkpoint: ContactProcessCheckpoint): boolean {
  return checkpoint.steps.some((step) => step.verification?.sendAttempted === true);
}

function failedCapability(error: SerializedExtensionError | undefined): string {
  const details = error?.details;
  if (!details) return "";
  if (typeof details.failedCapability === "string") return details.failedCapability;
  const diagnostic = details.compatibilityDiagnostic;
  if (diagnostic && typeof diagnostic === "object" && "capability" in diagnostic) {
    const capability = (diagnostic as { capability?: unknown }).capability;
    return typeof capability === "string" ? capability : "";
  }
  return "";
}

export function campaignContactFailureClass(checkpoint: ContactProcessCheckpoint): CampaignContactFailureClass {
  if (hasUnresolvedSendEvidence(checkpoint)) return "ambiguous";
  if (checkpoint.status === "images_required" || checkpoint.pauseReason === "images_required") return "images_required";
  if (checkpoint.pauseReason === "manual_pause") return "manual_pause";
  if (checkpointHasAnySendAttempt(checkpoint)) return "partial_send";

  const error = checkpointTechnicalError(checkpoint);
  const code = error?.code;
  if (code && (SYSTEMIC_ERROR_CODES.has(code) || COMPATIBILITY_ERROR_CODES.has(code))) return "systemic";
  if (code && LOCAL_SAFE_ERROR_CODES.has(code)) return "local_safe";
  if (["max_attempts", "open_conversation_failed"].includes(checkpoint.pauseReason ?? "") && error?.recoverable === true) {
    return "local_safe";
  }
  return error?.recoverable === true ? "local_safe" : "systemic";
}

export function campaignFailureRecord(
  checkpoint: ContactProcessCheckpoint,
  failedAt = new Date().toISOString()
): CampaignRecipientFailure {
  const step = checkpointStep(checkpoint);
  const error = checkpointTechnicalError(checkpoint);
  const errorCategory = classifyDiagnosticError(error ?? null);
  const operation = step?.kind ?? "open_conversation";
  const stage = step
    ? `${step.kind}:${step.status}`
    : checkpoint.pauseReason ?? checkpoint.status;
  const capability = failedCapability(error);
  const signature = [error?.code ?? "UNKNOWN", errorCategory, operation, stage, capability || "none"].join("|");
  const attempts = step?.attempts ?? checkpoint.openConversationFailures ?? checkpoint.openConversationAttempts;
  const sendAttempted = checkpointHasAnySendAttempt(checkpoint);
  const ambiguous = hasUnresolvedSendEvidence(checkpoint);
  return {
    errorCode: error?.code ?? ERROR_CODES.internal,
    errorCategory,
    operation,
    stage,
    capability: capability || null,
    attempts,
    sendAttempted,
    ambiguous,
    reconciled: !ambiguous,
    retryEligible: !ambiguous,
    signature,
    failedAt
  };
}
