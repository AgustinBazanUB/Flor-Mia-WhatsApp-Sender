import { describe, expect, it } from "vitest";
import { CampaignRuntime } from "../src/background/campaign-runtime";
import type { WhatsAppTransport } from "../src/background/whatsapp-transport";
import { CampaignEventPublisher } from "../src/campaign/events";
import { CampaignHistoryStore } from "../src/campaign/history-store";
import type {
  CampaignRepository,
  CampaignState,
  DailyLimitRepository,
  DailyLimitState
} from "../src/campaign/campaign-types";
import type { CampaignWakeupScheduler } from "../src/campaign/scheduler";
import type { ContactCheckpointRepository, ContactProcessCheckpoint } from "../src/engine/types";
import { createUnavailablePreflight } from "../src/compatibility/preflight-result";
import { StateStore, type KeyValueStorage } from "../src/storage/state-store";

const NOW = "2026-08-16T12:00:00.000Z";

class MemoryStorage implements KeyValueStorage {
  value: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> { return this.value; }
  async set(items: Record<string, unknown>): Promise<void> { this.value = { ...this.value, ...items }; }
}

class MemoryCampaigns implements CampaignRepository {
  constructor(public active: CampaignState | null) {}
  async loadActive() { return this.active; }
  async saveActive(value: CampaignState) { this.active = value; return value; }
  async clearActive() { this.active = null; }
}

class MemoryDaily implements DailyLimitRepository {
  constructor(public state: DailyLimitState) {}
  async load() { return this.state; }
  async recordCompletion() { return this.state; }
}

class MemoryCheckpoints implements ContactCheckpointRepository {
  constructor(public active: ContactProcessCheckpoint | null = null) {}
  clearCalls = 0;
  async loadActive() { return this.active; }
  async saveActive(value: ContactProcessCheckpoint) { this.active = value; return value; }
  async clearActive() { this.clearCalls += 1; this.active = null; }
}

class MemoryBlobs {
  deleted: string[] = [];
  async putCampaignImages() { /* no-op */ }
  async getImage() { return null; }
  async deleteCampaign(campaignId: string) { this.deleted.push(campaignId); return 1; }
}

class NoopWakeups implements CampaignWakeupScheduler {
  async schedule() { /* no-op */ }
  async cancel() { /* no-op */ }
}

function campaign(status: CampaignState["status"]): CampaignState {
  const completed = status === "completed";
  return {
    schemaVersion: 1,
    runToken: "run-final",
    campaignId: "campaign-final",
    campaignName: "Campaña final",
    createdBy: "flor_mia",
    status,
    recipients: [{
      recipientId: "recipient-1",
      phoneDigits: "5491112345678",
      maskedPhone: "+54••••••78",
      source: "flor_mia",
      position: 1,
      status: completed ? "completed" : "paused",
      ...(completed ? { completedAt: NOW } : {})
    }],
    text: "Hola",
    images: [{ imageId: "image-1", order: 1, name: "foto.png", type: "image/png", size: 3 }],
    currentRecipientIndex: completed ? null : 0,
    activeContactId: completed ? null : "recipient-1",
    lastCompletedContactId: completed ? "recipient-1" : null,
    completedRecipients: completed ? 1 : 0,
    batchNumber: 1,
    contactsCompletedInBatch: completed ? 1 : 0,
    pauseRequested: !completed,
    stopRequested: false,
    wait: null,
    blockReason: completed ? null : { code: "manual_pause", message: "Pausa", at: NOW, recoverable: true },
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
      countedContactKeys: completed ? ["campaign-final:recipient-1"] : [],
      updatedAt: NOW
    },
    sequence: completed ? 5 : 3,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    ...(completed ? { completedAt: NOW } : {})
  };
}

function checkpoint(status: ContactProcessCheckpoint["status"]): ContactProcessCheckpoint {
  return {
    schemaVersion: 1,
    checkpointId: "checkpoint-1",
    campaignId: "campaign-final",
    campaignName: "Campaña final",
    contact: { contactId: "recipient-1", phoneDigits: "5491112345678", maskedPhone: "+54••••••78" },
    steps: [],
    status,
    currentStepId: status === "completed" ? null : "text-1",
    lastConfirmedStepId: status === "completed" ? "text-1" : null,
    openConversationAttempts: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...(status === "completed" ? { completedAt: NOW } : {}),
    history: []
  };
}

function setup(state: CampaignState, activeCheckpoint: ContactProcessCheckpoint | null = null) {
  const storage = new MemoryStorage();
  const blobs = new MemoryBlobs();
  const checkpoints = new MemoryCheckpoints(activeCheckpoint);
  const history = new CampaignHistoryStore(storage);
  const campaigns = new MemoryCampaigns(state);
  const runtime = new CampaignRuntime({
    stateStore: new StateStore(storage),
    blobStore: blobs,
    checkpointStore: checkpoints,
    transport: {} as WhatsAppTransport,
    runPreflight: async (request) => createUnavailablePreflight("fixture", request),
    onContactCheckpoint: async () => undefined,
    campaigns,
    dailyLimit: new MemoryDaily(state.dailyLimit),
    wakeups: new NoopWakeups(),
    events: new CampaignEventPublisher(storage),
    history,
    extensionVersion: "0.6.0",
    now: () => new Date(NOW)
  });
  return { runtime, blobs, checkpoints, history, campaigns };
}

describe("CampaignRuntime terminal finalization", () => {
  it("ignores an alarm from an obsolete run token", async () => {
    const state = campaign("paused");
    const { runtime } = setup(state, checkpoint("paused"));
    await expect(runtime.handleAlarm(state.campaignId, "obsolete-run")).resolves.toBeNull();
  });

  it("records history, clears a confirmed checkpoint and deletes shared images only after completion", async () => {
    const state = campaign("completed");
    const { runtime, blobs, checkpoints, history } = setup(state, checkpoint("completed"));
    const publicStatus = await runtime.syncCampaign(state);

    expect(publicStatus.status).toBe("completed");
    expect(publicStatus.finalSummary).toMatchObject({ sent: 1, total: 1, extensionVersion: "0.6.0" });
    expect(checkpoints.active).toBeNull();
    expect(blobs.deleted).toEqual(["campaign-final"]);
    expect(await history.list()).toEqual([expect.objectContaining({
      campaignId: "campaign-final",
      status: "completed",
      dailyCounterImpact: 1
    })]);
  });

  it("retains images and checkpoint while paused", async () => {
    const state = campaign("paused");
    const { runtime, blobs, checkpoints, history } = setup(state, checkpoint("paused"));
    const publicStatus = await runtime.syncCampaign(state);

    expect(publicStatus.status).toBe("paused");
    expect(blobs.deleted).toEqual([]);
    expect(checkpoints.active?.status).toBe("paused");
    expect(await history.list()).toEqual([]);
  });

  it("returns the same full PULL snapshot after a Web-App reconnect without changing campaign state", async () => {
    const state = campaign("paused");
    const { runtime, blobs } = setup(state, checkpoint("paused"));
    const before = await runtime.getStatus("campaign-final");
    const after = await runtime.getStatus("campaign-final");

    expect(after).toEqual(before);
    expect(after).toMatchObject({ campaignId: "campaign-final", status: "paused", sequence: 3, sent: 0, total: 1 });
    expect(blobs.deleted).toEqual([]);
  });

  it("keeps a stopped campaign loaded until explicit release, then frees checkpoint, blobs and active slot", async () => {
    const paused = campaign("paused");
    const stopped: CampaignState = {
      ...paused,
      status: "stopped",
      recipients: paused.recipients.map((recipient) => ({ ...recipient, status: "stopped" })),
      currentRecipientIndex: null,
      activeContactId: null,
      pauseRequested: false,
      stopRequested: true,
      blockReason: null,
      stoppedAt: NOW,
      sequence: 4
    };
    const { runtime, blobs, checkpoints, history, campaigns } = setup(stopped, checkpoint("paused"));
    const publicStatus = await runtime.syncCampaign(stopped);

    expect(publicStatus.status).toBe("stopped");
    expect(blobs.deleted).toEqual([]);
    expect(checkpoints.active).not.toBeNull();
    expect(await history.list()).toEqual([expect.objectContaining({ status: "stopped", errorCategory: "USER_STOP" })]);

    await expect(runtime.release("campaign-final")).resolves.toMatchObject({ campaignId: "campaign-final" });
    expect(blobs.deleted).toEqual(["campaign-final"]);
    expect(checkpoints.active).toBeNull();
    expect(campaigns.active).toBeNull();
    expect(await history.list()).toEqual([expect.objectContaining({ status: "stopped", errorCategory: "USER_STOP" })]);
  });

  it("archives a stopped campaign while retaining ambiguous post-click evidence for explicit cancel/review", async () => {
    const paused = campaign("paused");
    const stopped: CampaignState = {
      ...paused,
      status: "stopped",
      currentRecipientIndex: null,
      activeContactId: null,
      stopRequested: true,
      stoppedAt: NOW,
      sequence: 4
    };
    const ambiguous = checkpoint("paused");
    ambiguous.pauseReason = "verification_pending";
    ambiguous.steps = [{
      id: "text",
      operationId: "campaign-final:recipient-1:text",
      position: 1,
      kind: "text",
      text: "Hola",
      status: "verification_pending",
      attempts: 1,
      verification: { outcome: "ambiguous", method: "test", observedAt: NOW, sendAttempted: true }
    }];
    const { runtime, blobs, checkpoints, history } = setup(stopped, ambiguous);
    await expect(runtime.syncCampaign(stopped)).resolves.toMatchObject({ status: "stopped" });
    expect(blobs.deleted).toEqual([]);
    expect(checkpoints.active).toBe(ambiguous);
    expect(await history.list()).toEqual([expect.objectContaining({ status: "stopped" })]);
  });

  it("refuses completion cleanup if a contact checkpoint is incomplete", async () => {
    const state = campaign("completed");
    const { runtime, blobs, history } = setup(state, checkpoint("paused"));

    await expect(runtime.syncCampaign(state)).rejects.toThrow(/checkpoint/i);
    expect(blobs.deleted).toEqual([]);
    expect(await history.list()).toEqual([]);
  });
});
