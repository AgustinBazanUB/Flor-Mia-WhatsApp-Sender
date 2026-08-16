import type { StepReconciliationResult } from "../engine/types";
import {
  canonicalMessageText,
  findComposer,
  findMediaPreview,
  findMediaSendButton,
  outgoingMediaMessages,
  outgoingMessages
} from "./selectors";
import { waitForCondition } from "./wait";

export interface ReconcileStepInput {
  kind: "image" | "text";
  operationId: string;
  baselineOutgoingIds: string[];
  message?: string;
  timeoutMs?: number;
}

function result(outcome: StepReconciliationResult["outcome"], method: string, sendAttempted: boolean, outgoingMessageId?: string): StepReconciliationResult {
  return {
    outcome,
    verification: {
      outcome,
      method,
      observedAt: new Date().toISOString(),
      sendAttempted,
      ...(outgoingMessageId ? { outgoingMessageId } : {})
    }
  };
}

function inspect(input: ReconcileStepInput): StepReconciliationResult | null {
  const baseline = new Set(input.baselineOutgoingIds);
  if (input.kind === "text") {
    const expected = canonicalMessageText(input.message ?? "");
    const outgoing = outgoingMessages().find((item) => !baseline.has(item.identity) && item.text === expected);
    if (outgoing) return result("confirmed", "reconciled-new-outgoing-text-dom", true, outgoing.identity);
    const composer = findComposer();
    if (composer && canonicalMessageText(composer.element.textContent ?? "") === expected && expected) {
      return result("not_sent", "composer-still-contains-expected-text", false);
    }
    return null;
  }

  const outgoing = outgoingMediaMessages().find((item) => !baseline.has(item.identity));
  if (outgoing) return result("confirmed", "reconciled-new-outgoing-media-dom", true, outgoing.identity);
  const preview = findMediaPreview();
  if (preview && findMediaSendButton(preview.element)) {
    return result("not_sent", "media-preview-still-awaiting-send", false);
  }
  return null;
}

export async function reconcileWhatsAppStep(input: ReconcileStepInput): Promise<StepReconciliationResult> {
  const immediate = inspect(input);
  if (immediate) return immediate;
  const resolved = await waitForCondition(() => inspect(input), {
    timeoutMs: input.timeoutMs ?? 6_000,
    description: "evidencia suficiente para reconciliar el envío"
  }).catch(() => null);
  return resolved ?? result("ambiguous", "no-conclusive-dom-evidence", true);
}
