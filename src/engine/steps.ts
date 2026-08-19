import type { ContactProcessCheckpoint, ContactStep, ImageContactStep, TextContactStep } from "./types";

export interface ContactCheckpointInput {
  campaignId: string;
  campaignName: string;
  contact: ContactProcessCheckpoint["contact"];
  images: Array<ImageContactStep["image"]>;
  text: string;
  now?: string;
}

function operationId(campaignId: string, contactId: string, stepId: string): string {
  return `${campaignId}:${contactId}:${stepId}`;
}

export function createContactSteps(input: ContactCheckpointInput): ContactStep[] {
  const steps: ContactStep[] = [];
  for (const image of [...input.images].sort((a, b) => a.order - b.order)) {
    const id = `image-${image.order}`;
    steps.push({
      id,
      operationId: operationId(input.campaignId, input.contact.contactId, id),
      position: steps.length + 1,
      kind: "image",
      image,
      status: "pending",
      attempts: 0
    });
  }
  if (input.text.trim()) {
    const id = "text";
    const step: TextContactStep = {
      id,
      operationId: operationId(input.campaignId, input.contact.contactId, id),
      position: steps.length + 1,
      kind: "text",
      text: input.text,
      status: "pending",
      attempts: 0
    };
    steps.push(step);
  }
  return steps;
}

export function createContactCheckpoint(input: ContactCheckpointInput): ContactProcessCheckpoint {
  const now = input.now ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    checkpointId: `${input.campaignId}:${input.contact.contactId}`,
    campaignId: input.campaignId,
    campaignName: input.campaignName,
    contact: input.contact,
    steps: createContactSteps(input),
    status: "pending",
    currentStepId: null,
    lastConfirmedStepId: null,
    openConversationAttempts: 0,
    createdAt: now,
    updatedAt: now,
    history: []
  };
}

export function markInterruptedCheckpointAmbiguous(
  checkpoint: ContactProcessCheckpoint,
  now = new Date().toISOString()
): ContactProcessCheckpoint {
  const steps = checkpoint.steps.map((step): ContactStep => {
    if (step.status !== "in_progress") return { ...step };
    if (step.verification?.sendAttempted !== true) {
      return { ...step, status: "pending", verification: undefined };
    }
    return {
      ...step,
      status: "verification_pending",
      verification: {
        outcome: "ambiguous",
        method: "service-worker-rehydration",
        observedAt: now,
        sendAttempted: step.verification.sendAttempted,
        ...(step.verification?.baselineOutgoingIds ? { baselineOutgoingIds: step.verification.baselineOutgoingIds } : {})
      }
    };
  });
  const hasInterruptedStep = steps.some((step) => step.status === "verification_pending");
  if (!hasInterruptedStep && checkpoint.status !== "opening_chat" && checkpoint.status !== "running") {
    return { ...checkpoint, steps };
  }
  return {
    ...checkpoint,
    steps,
    status: "paused",
    pauseReason: hasInterruptedStep ? "verification_pending" : "open_conversation_failed",
    updatedAt: now
  };
}
