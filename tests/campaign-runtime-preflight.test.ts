import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { CampaignRuntime } from "../src/background/campaign-runtime";
import type { WhatsAppTransport } from "../src/background/whatsapp-transport";
import type {
  CampaignRepository,
  CampaignState,
  DailyLimitRepository,
  DailyLimitState
} from "../src/campaign/campaign-types";
import type { CampaignWakeupScheduler } from "../src/campaign/scheduler";
import { createUnavailablePreflight } from "../src/compatibility/preflight-result";
import type { WhatsAppPreflightRequest } from "../src/compatibility/types";
import type { WhatsAppPreflightResult } from "../src/shared/state";
import { CampaignBlobStore } from "../src/storage/blob-store";
import { ContactCheckpointStore } from "../src/storage/checkpoint-store";
import { StateStore, type KeyValueStorage } from "../src/storage/state-store";

const NOW = "2026-08-15T10:00:00.000Z";

class MemoryStorage implements KeyValueStorage {
  value: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> { return this.value; }
  async set(items: Record<string, unknown>): Promise<void> { this.value = { ...this.value, ...items }; }
}

class MemoryCampaigns implements CampaignRepository {
  constructor(public value: CampaignState | null) {}
  async loadActive(): Promise<CampaignState | null> { return this.value; }
  async saveActive(campaign: CampaignState): Promise<CampaignState> { this.value = campaign; return campaign; }
  async clearActive(): Promise<void> { this.value = null; }
}

class MemoryDaily implements DailyLimitRepository {
  constructor(private readonly state: DailyLimitState) {}
  async load(): Promise<DailyLimitState> { return this.state; }
  async recordCompletion(): Promise<DailyLimitState> { return this.state; }
}

class NoopWakeups implements CampaignWakeupScheduler {
  async schedule(): Promise<void> { /* no-op */ }
  async cancel(): Promise<void> { /* no-op */ }
}

function campaign(): CampaignState {
  const dailyLimit = {
    localDate: "2026-08-15",
    completedToday: 0,
    limit: 1_000,
    remaining: 1_000,
    countedContactKeys: [],
    updatedAt: NOW
  };
  return {
    schemaVersion: 1,
    runToken: "run-preflight",
    campaignId: "campaign-1",
    campaignName: "Campaña contextual",
    createdBy: "tests",
    status: "received",
    recipients: [{
      recipientId: "contact-1",
      name: "Cliente autorizado",
      phoneDigits: "5491112345678",
      maskedPhone: "+54••••••78",
      source: "flor_mia",
      position: 1,
      status: "pending"
    }],
    text: "Mensaje autorizado",
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
    policy: {
      contactsPerBatch: 3,
      delayBetweenContactsMs: 1_500,
      delayBetweenBatchesMs: 15_000,
      dailyContactLimit: 1_000,
      whatsappLoadWaitMs: 30_000
    },
    dailyLimit,
    sequence: 1,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function green(request: WhatsAppPreflightRequest): WhatsAppPreflightResult {
  return {
    ...createUnavailablePreflight("fixture", request, { pageDetected: true, contentScriptConnected: true }),
    contentInstanceId: "fixture-content",
    documentReady: true,
    sessionReady: true,
    mainInterfaceReady: true,
    operational: true,
    overallStatus: "GREEN",
    status: "ready",
    message: "GREEN"
  };
}

function runtimeWith(
  preflight: (request: WhatsAppPreflightRequest) => Promise<WhatsAppPreflightResult>,
  transport: Record<string, unknown> = {}
): CampaignRuntime {
  const storage = new MemoryStorage();
  const active = campaign();
  return new CampaignRuntime({
    stateStore: new StateStore(storage),
    blobStore: new CampaignBlobStore(indexedDB),
    checkpointStore: new ContactCheckpointStore(storage),
    transport: transport as unknown as WhatsAppTransport,
    runPreflight: preflight,
    onContactCheckpoint: async () => undefined,
    campaigns: new MemoryCampaigns(active),
    dailyLimit: new MemoryDaily(active.dailyLimit),
    wakeups: new NoopWakeups(),
    now: () => new Date(NOW)
  });
}

describe("CampaignRuntime non-destructive startup preflight", () => {
  it("runs exactly one non-navigating campaign-start preflight with real requirements metadata", async () => {
    const requests: WhatsAppPreflightRequest[] = [];
    const requireTab = vi.fn(async () => ({ id: 7 }));
    const send = vi.fn(async () => ({ navigationStarted: true }));
    const waitForContent = vi.fn(async () => green({ level: "lightweight" }));
    const runtime = runtimeWith(async (request) => {
      requests.push(request);
      return green(request);
    }, { requireTab, send, waitForContent });

    const result = await runtime.runCampaignPreflight("campaign-1");

    expect(result.overallStatus).toBe("GREEN");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      level: "full",
      purpose: "campaign_start",
      requirements: { needsText: true, needsImages: false }
    });
    expect(requireTab).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(waitForContent).not.toHaveBeenCalled();
  });

  it("returns a RED startup result without ever selecting or opening a recipient", async () => {
    const requireTab = vi.fn();
    const send = vi.fn();
    const waitForContent = vi.fn();
    const runtime = runtimeWith(async (request) => createUnavailablePreflight("WhatsApp no está abierto", request), {
      requireTab, send, waitForContent
    });

    const result = await runtime.runCampaignPreflight("campaign-1");

    expect(result.overallStatus).toBe("RED");
    expect(requireTab).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(waitForContent).not.toHaveBeenCalled();
  });
});
