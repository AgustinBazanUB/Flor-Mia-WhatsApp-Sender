import type { CompatibilityState, WhatsAppCapability } from "../compatibility/types";
import type { ContactProcessCheckpoint } from "../engine/types";
import { isExtensionErrorCode, type SerializedExtensionError } from "../shared/errors";
import { classifyDiagnosticError } from "./taxonomy";
import type { TechnicalTraceInput } from "./types";

function duration(start: string, end: string | null): number | null {
  if (!end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
}

function capabilityFrom(error: SerializedExtensionError | undefined): WhatsAppCapability | null {
  const raw = (error?.details?.compatibilityDiagnostic as Record<string, unknown> | undefined)?.capability;
  return typeof raw === "string" ? raw as WhatsAppCapability : null;
}

export function technicalTraceFromCheckpoint(
  checkpoint: ContactProcessCheckpoint,
  compatibility: CompatibilityState
): TechnicalTraceInput[] {
  return checkpoint.history.map((history) => {
    const step = checkpoint.steps.find((candidate) => candidate.id === history.stepId);
    const error = step?.error ?? (checkpoint.currentStepId === history.stepId ? checkpoint.error : undefined);
    const capability = capabilityFrom(error);
    const timestampStart = step?.lastAttemptAt ?? step?.startedAt ?? history.timestamp;
    const timestampEnd = history.result === "started" ? null : history.timestamp;
    const errorForCategory = history.errorCode && isExtensionErrorCode(history.errorCode)
      ? { code: history.errorCode, message: "", recoverable: true } satisfies SerializedExtensionError
      : error;
    return {
      traceId: `${checkpoint.checkpointId}:${history.stepId}:${history.attempt}:${history.result}:${history.timestamp}`,
      timestampStart,
      timestampEnd,
      campaignId: history.campaignId,
      contactId: history.contactId,
      stepId: history.stepId,
      attempt: history.attempt,
      action: step?.kind === "image" ? "process_image_step" : step?.kind === "text" ? "process_text_step" : "process_contact_step",
      outcome: history.result,
      errorCode: history.errorCode ?? error?.code ?? null,
      errorCategory: errorForCategory || history.result === "ambiguous" || history.result === "missing_resource"
        ? classifyDiagnosticError(errorForCategory, {
          pauseReason: history.result === "ambiguous" ? "verification_pending" : history.result === "missing_resource" ? "images_required" : checkpoint.pauseReason
        })
        : null,
      verificationMethod: history.verificationMethod ?? step?.verification?.method ?? null,
      capability,
      strategy: capability
        ? compatibility.lastPreflight?.capabilities[capability]?.selectedStrategy ?? compatibility.lastKnownGood[capability]?.selectedStrategy ?? null
        : null,
      durationMs: duration(timestampStart, timestampEnd)
    };
  });
}
