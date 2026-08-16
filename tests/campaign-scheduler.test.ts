import { describe, expect, it } from "vitest";
import { CampaignScheduler, type CampaignWakeupScheduler } from "../src/campaign/scheduler";
import type { CampaignState } from "../src/campaign/campaign-types";

class FakeWakeups implements CampaignWakeupScheduler {
  readonly scheduled: Array<{ campaignId: string; when: number }> = [];
  readonly cancelled: string[] = [];
  async schedule(campaignId: string, when: number): Promise<void> { this.scheduled.push({ campaignId, when }); }
  async cancel(campaignId: string): Promise<void> { this.cancelled.push(campaignId); }
}

function campaign(status: CampaignState["status"]): CampaignState {
  return {
    schemaVersion: 1,
    campaignId: "campaign-1",
    campaignName: "Prueba",
    createdBy: "tests",
    status,
    recipients: [],
    text: "Hola",
    images: [],
    currentRecipientIndex: null,
    activeContactId: null,
    lastCompletedContactId: null,
    completedRecipients: 0,
    batchNumber: 1,
    contactsCompletedInBatch: 0,
    pauseRequested: false,
    stopRequested: false,
    wait: null,
    blockReason: null,
    policy: { contactsPerBatch: 3, delayBetweenContactsMs: 0, delayBetweenBatchesMs: 15_000, dailyContactLimit: 1_000, whatsappLoadWaitMs: 30_000 },
    dailyLimit: { localDate: "2026-08-15", completedToday: 0, limit: 1_000, remaining: 1_000, countedContactKeys: [], updatedAt: "2026-08-15T00:00:00.000Z" },
    sequence: 1,
    receivedAt: "2026-08-15T00:00:00.000Z",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z"
  };
}

describe("persistent campaign scheduler", () => {
  it("runs independently of popup lifetime and schedules the next persisted boundary", async () => {
    const wakeups = new FakeWakeups();
    const waiting = {
      ...campaign("waiting_batch"),
      wait: { kind: "between_batches" as const, scheduledAt: "2026-08-15T10:00:00.000Z", until: "2026-08-15T10:00:15.000Z" }
    };
    const engine = { advance: async () => waiting };
    const scheduler = new CampaignScheduler({ engine: engine as never, wakeups, now: () => Date.parse("2026-08-15T10:00:00.000Z") });
    await scheduler.run("campaign-1");
    expect(wakeups.scheduled).toEqual([{ campaignId: "campaign-1", when: Date.parse(waiting.wait.until) }]);
  });

  it("coalesces concurrent wakeups so only one contact can run", async () => {
    const wakeups = new FakeWakeups();
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = {
      advance: async () => {
        executions += 1;
        await gate;
        return campaign("completed");
      }
    };
    const scheduler = new CampaignScheduler({ engine: engine as never, wakeups });
    const first = scheduler.run("campaign-1");
    const second = scheduler.run("campaign-1");
    release();
    await Promise.all([first, second]);
    expect(executions).toBe(1);
    expect(wakeups.cancelled).toEqual(["campaign-1"]);
  });
});
