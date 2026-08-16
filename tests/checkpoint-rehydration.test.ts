import { describe, expect, it } from "vitest";
import { createContactCheckpoint, markInterruptedCheckpointAmbiguous } from "../src/engine/steps";
import type { ContactProcessCheckpoint } from "../src/engine/types";

function interrupted(sendAttempted: boolean): ContactProcessCheckpoint {
  const initial = createContactCheckpoint({
    campaignId: "campaign-1",
    campaignName: "Prueba",
    contact: { contactId: "contact-1", phoneDigits: "5491112345678", maskedPhone: "+54••••••5678" },
    images: [{ imageId: "asset-1", order: 1, name: "uno.png", type: "image/png", size: 3 }],
    text: "Hola",
    now: "2026-08-15T00:00:00.000Z"
  });
  return {
    ...initial,
    status: "running",
    currentStepId: "image-1",
    steps: initial.steps.map((step) => step.id === "image-1"
      ? {
          ...step,
          status: "in_progress" as const,
          ...(sendAttempted ? {
            verification: {
              outcome: "ambiguous" as const,
              method: "send-attempted-checkpoint",
              observedAt: "2026-08-15T00:00:01.000Z",
              sendAttempted: true,
              baselineOutgoingIds: ["before-1"]
            }
          } : {})
        }
      : step)
  };
}

describe("service worker checkpoint rehydration", () => {
  it("returns an interrupted but never-clicked operation to pending", () => {
    const result = markInterruptedCheckpointAmbiguous(interrupted(false));
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("open_conversation_failed");
    expect(result.steps[0]?.status).toBe("pending");
  });

  it("keeps an interrupted post-click operation verification-pending", () => {
    const result = markInterruptedCheckpointAmbiguous(interrupted(true));
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("verification_pending");
    expect(result.steps[0]).toMatchObject({
      status: "verification_pending",
      verification: { sendAttempted: true, baselineOutgoingIds: ["before-1"] }
    });
  });
});
