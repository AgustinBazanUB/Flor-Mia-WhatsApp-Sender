import { describe, expect, it } from "vitest";
import { toCampaignPublicStatus } from "../src/campaign/public-status";
import type { CampaignRecipientState, CampaignState } from "../src/campaign/campaign-types";

const NOW = "2026-09-03T15:00:00.000Z";

function recipient(overrides: Partial<CampaignRecipientState> = {}): CampaignRecipientState {
  return {
    recipientId: "recipient_123",
    clientId: "customer_private",
    name: "Nombre que no debe salir",
    phoneDigits: "5491112345678",
    maskedPhone: "+54••••••78",
    source: "flor_mia",
    position: 1,
    status: "completed",
    completedAt: NOW,
    deliveryConfidence: "confirmed",
    ...overrides,
  };
}

function campaign(recipients: CampaignRecipientState[]): CampaignState {
  return {
    schemaVersion: 1,
    runToken: "run-recipient-result",
    campaignId: "campaign-recipient-result",
    campaignName: "Campaña cooldown",
    createdBy: "user-1",
    status: "running",
    recipients,
    text: "Mensaje",
    images: [],
    currentRecipientIndex: null,
    activeContactId: null,
    lastCompletedContactId: recipients.findLast((item) => item.status === "completed")?.recipientId ?? null,
    completedRecipients: recipients.filter((item) => item.status === "completed").length,
    batchNumber: 1,
    contactsCompletedInBatch: recipients.filter((item) => ["completed", "error"].includes(item.status)).length,
    pauseRequested: false,
    stopRequested: false,
    wait: null,
    blockReason: null,
    policy: {
      contactsPerBatch: 3,
      delayBetweenContactsMs: 1000,
      delayBetweenBatchesMs: 15000,
      dailyContactLimit: 1000,
      whatsappLoadWaitMs: 30000,
    },
    dailyLimit: {
      localDate: "2026-09-03",
      completedToday: 1,
      limit: 1000,
      remaining: 999,
      countedContactKeys: [],
      updatedAt: NOW,
    },
    sequence: 7,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function publicStatus(recipients: CampaignRecipientState[]) {
  return toCampaignPublicStatus(campaign(recipients), null, {
    extensionVersion: "0.9.7-test",
    redGreen: "GREEN",
  });
}

describe("campaign recipient result sync", () => {
  it("publishes a minimal confirmed result without name, phone or clientId", () => {
    const status = publicStatus([recipient()]);
    expect(status.lastRecipientResult).toEqual({
      recipientId: "recipient_123",
      outcome: "confirmed",
      completedAt: NOW,
    });
    const serialized = JSON.stringify(status.lastRecipientResult);
    expect(serialized).not.toContain("Nombre que no debe salir");
    expect(serialized).not.toContain("5491112345678");
    expect(serialized).not.toContain("customer_private");
  });

  it("distinguishes unverified sends from confirmed sends", () => {
    const status = publicStatus([recipient({ deliveryConfidence: "unverified" })]);
    expect(status.lastRecipientResult?.outcome).toBe("unverified");
  });

  it("reports safe failed recipients as failed and keeps the latest terminal result", () => {
    const older = recipient({ recipientId: "recipient_old", completedAt: "2026-09-03T14:59:00.000Z" });
    const failed = recipient({
      recipientId: "recipient_failed",
      status: "error",
      completedAt: "2026-09-03T15:01:00.000Z",
      deliveryConfidence: undefined,
    });
    const status = publicStatus([older, failed]);
    expect(status.lastRecipientResult).toEqual({
      recipientId: "recipient_failed",
      outcome: "failed",
      completedAt: "2026-09-03T15:01:00.000Z",
    });
  });
});