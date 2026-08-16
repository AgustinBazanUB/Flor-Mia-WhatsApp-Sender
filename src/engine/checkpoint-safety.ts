import type { ContactProcessCheckpoint } from "./types";

export function hasUnresolvedSendEvidence(checkpoint: ContactProcessCheckpoint | null): boolean {
  if (!checkpoint) return false;
  if (checkpoint.pauseReason === "verification_pending") return true;
  return checkpoint.steps.some((step) =>
    step.status === "verification_pending"
    || (step.status === "in_progress" && step.verification?.sendAttempted === true));
}
