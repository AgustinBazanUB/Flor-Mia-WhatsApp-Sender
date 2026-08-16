import { describe, expect, it } from "vitest";
import { CampaignEventPublisher, CAMPAIGN_EVENT_KEY } from "../src/campaign/events";
import { CampaignHistoryStore } from "../src/campaign/history-store";
import { toCampaignPublicStatus } from "../src/campaign/public-status";
import type { CampaignHistoryRecord, CampaignState } from "../src/campaign/campaign-types";
import type { KeyValueStorage } from "../src/storage/state-store";

class MemoryStorage implements KeyValueStorage {
  value: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> { return this.value; }
  async set(items: Record<string, unknown>): Promise<void> { this.value = { ...this.value, ...items }; }
}

const NOW = "2026-08-16T12:00:00.000Z";

function campaign(status: CampaignState["status"] = "received", sequence = 1): CampaignState {
  const completed = status === "completed";
  return {
    schemaVersion: 1,
    campaignId: "campaign-sync",
    campaignName: "Campaña de aceptación",
    createdBy: "flor_mia",
    status,
    recipients: [{
      recipientId: "recipient-private-1",
      name: "Nombre privado",
      phoneDigits: "5491112345678",
      maskedPhone: "+54••••••78",
      source: "flor_mia",
      position: 1,
      status: completed ? "completed" : "pending",
      ...(completed ? { completedAt: NOW } : {})
    }],
    text: "Texto autorizado",
    images: [],
    currentRecipientIndex: null,
    activeContactId: null,
    lastCompletedContactId: completed ? "recipient-private-1" : null,
    completedRecipients: completed ? 1 : 0,
    batchNumber: 1,
    contactsCompletedInBatch: completed ? 1 : 0,
    pauseRequested: false,
    stopRequested: false,
    wait: null,
    blockReason: null,
    policy: {
      contactsPerBatch: 3,
      delayBetweenContactsMs: 1_000,
      delayBetweenBatchesMs: 15_000,
      dailyContactLimit: 1_000,
      whatsappLoadWaitMs: 30_000
    },
    dailyLimit: {
      localDate: "2026-08-16",
      completedToday: completed ? 1 : 0,
      limit: 1_000,
      remaining: completed ? 999 : 1_000,
      countedContactKeys: completed ? ["campaign-sync:recipient-private-1"] : [],
      updatedAt: NOW
    },
    sequence,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...(completed ? { startedAt: NOW, completedAt: NOW } : {})
  };
}

function status(state: CampaignState) {
  return toCampaignPublicStatus(state, null, { extensionVersion: "0.6.0", redGreen: "GREEN" });
}

describe("public campaign synchronization", () => {
  it("publishes one persisted latest event with monotonic sequence and ignores stale snapshots", async () => {
    const storage = new MemoryStorage();
    const publisher = new CampaignEventPublisher(storage);

    expect((await publisher.publish(status(campaign("received", 1))))?.type).toBe("CAMPAIGN_ACCEPTED");
    expect(await publisher.publish(status(campaign("received", 1)))).toBeNull();
    expect(await publisher.publish(status(campaign("received", 0)))).toBeNull();

    const running = campaign("running", 2);
    expect((await publisher.publish(status(running)))?.type).toBe("CAMPAIGN_STARTED");
    const paused = { ...running, status: "paused" as const, sequence: 3 };
    expect((await publisher.publish(status(paused)))?.type).toBe("CAMPAIGN_PAUSED");
    const resumed = { ...running, sequence: 4 };
    expect((await publisher.publish(status(resumed)))?.type).toBe("CAMPAIGN_RESUMED");

    expect((storage.value[CAMPAIGN_EVENT_KEY] as { sequence: number }).sequence).toBe(4);
    expect(Object.keys(storage.value).filter((key) => key.startsWith(CAMPAIGN_EVENT_KEY))).toHaveLength(2);
  });

  it("builds a reconnectable full snapshot without private counter keys or names by default", () => {
    const publicStatus = status(campaign("completed", 8));
    const serialized = JSON.stringify(publicStatus);

    expect(publicStatus).toMatchObject({
      snapshotSchemaVersion: 1,
      sent: 1,
      total: 1,
      remaining: 0,
      progressPercentage: 100,
      redGreen: "GREEN",
      extensionVersion: "0.6.0"
    });
    expect(publicStatus.finalSummary).toMatchObject({ sent: 1, total: 1, failed: 0 });
    expect(publicStatus.dailyLimit.countedContacts).toBe(1);
    expect(serialized).not.toContain("countedContactKeys");
    expect(serialized).not.toContain("Nombre privado");
    expect(serialized).not.toContain("5491112345678");
    expect(JSON.parse(serialized)).toEqual(publicStatus);
  });

  it("keeps a bounded, idempotent and recipient-free campaign history", async () => {
    const storage = new MemoryStorage();
    const history = new CampaignHistoryStore(storage, 2);
    const record = (campaignId: string, recordedAt: string): CampaignHistoryRecord => ({
      historySchemaVersion: 1,
      campaignId,
      campaignName: `Campaña ${campaignId}`,
      startedAt: NOW,
      completedAt: recordedAt,
      total: 2,
      completed: 2,
      status: "completed",
      errorCategory: null,
      extensionVersion: "0.6.0",
      dailyCounterImpact: 2,
      durationMs: 100,
      batches: 1,
      recordedAt
    });
    await history.upsert(record("one", "2026-08-16T10:00:00.000Z"));
    await history.upsert(record("two", "2026-08-16T11:00:00.000Z"));
    await history.upsert(record("three", "2026-08-16T12:00:00.000Z"));
    await history.upsert({ ...record("three", "2026-08-16T13:00:00.000Z"), completed: 1 });

    const records = await history.list();
    expect(records.map((item) => item.campaignId)).toEqual(["three", "two"]);
    expect(records[0]?.completed).toBe(1);
    expect(JSON.stringify(records)).not.toContain("recipients");
  });
});
