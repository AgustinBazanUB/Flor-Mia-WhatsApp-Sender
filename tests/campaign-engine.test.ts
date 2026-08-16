import { describe, expect, it } from "vitest";
import { CampaignEngine, type CampaignContactRunner } from "../src/campaign/campaign-engine";
import { DEFAULT_CAMPAIGN_POLICY } from "../src/campaign/campaign-policy";
import { createCampaignState } from "../src/campaign/campaign-store";
import type {
  CampaignPolicyConfig,
  CampaignRepository,
  CampaignState,
  DailyLimitRepository,
  DailyLimitState
} from "../src/campaign/campaign-types";
import { progressForCampaign } from "../src/campaign/progress";
import { refreshDailyLimit, incrementDailyLimit } from "../src/campaign/daily-limit";
import { createContactCheckpoint } from "../src/engine/steps";
import type { ContactCheckpointRepository, ContactProcessCheckpoint, ContactStep } from "../src/engine/types";
import { validateCampaignInput } from "../src/shared/campaign";
import { ERROR_CODES } from "../src/shared/errors";

const NOW = new Date(2026, 7, 15, 10, 0, 0);

class MemoryCampaignStore implements CampaignRepository {
  active: CampaignState | null = null;
  async loadActive(): Promise<CampaignState | null> { return this.active; }
  async saveActive(campaign: CampaignState): Promise<CampaignState> { this.active = campaign; return campaign; }
  async clearActive(): Promise<void> { this.active = null; }
}

class MemoryCheckpointStore implements ContactCheckpointRepository {
  active: ContactProcessCheckpoint | null = null;
  async loadActive(): Promise<ContactProcessCheckpoint | null> { return this.active; }
  async saveActive(checkpoint: ContactProcessCheckpoint): Promise<ContactProcessCheckpoint> { this.active = checkpoint; return checkpoint; }
  async clearActive(): Promise<void> { this.active = null; }
}

class MemoryDailyLimit implements DailyLimitRepository {
  state: DailyLimitState | null = null;
  async load(limit: number, now = NOW): Promise<DailyLimitState> {
    this.state = refreshDailyLimit(this.state, limit, now);
    return this.state;
  }
  async recordCompletion(limit: number, key: string, now = NOW): Promise<DailyLimitState> {
    this.state = incrementDailyLimit(await this.load(limit, now), key, now);
    return this.state;
  }
}

type RunnerOutcome = "completed" | "paused" | "images_required" | "ambiguous" | "capability_break" | "reloading" | "tab_closed" | "session_closed" | "failed";

function confirmedSteps(steps: ContactStep[]): ContactStep[] {
  return steps.map((step) => ({
    ...step,
    status: "confirmed",
    attempts: Math.max(1, step.attempts),
    completedAt: NOW.toISOString(),
    verification: {
      outcome: "confirmed",
      method: "fake-dom",
      observedAt: NOW.toISOString(),
      sendAttempted: true
    }
  })) as ContactStep[];
}

class FakeContactRunner implements CampaignContactRunner {
  readonly calls: string[] = [];
  readonly outcomes = new Map<string, RunnerOutcome[]>();
  onRun?: (checkpoint: ContactProcessCheckpoint) => Promise<void>;
  concurrent = 0;
  maxConcurrent = 0;

  async run(checkpoint: ContactProcessCheckpoint, shouldPause: () => Promise<boolean>): Promise<ContactProcessCheckpoint> {
    this.calls.push(checkpoint.contact.contactId);
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      await this.onRun?.(checkpoint);
      if (await shouldPause()) {
        return { ...checkpoint, status: "paused", pauseReason: "manual_pause", currentStepId: checkpoint.steps[0]?.id ?? null };
      }
      const queue = this.outcomes.get(checkpoint.contact.contactId) ?? [];
      const outcome = queue.shift() ?? "completed";
      this.outcomes.set(checkpoint.contact.contactId, queue);
      const currentStepId = checkpoint.steps[0]?.id ?? null;
      if (outcome === "completed") {
        return {
          ...checkpoint,
          status: "completed",
          steps: confirmedSteps(checkpoint.steps),
          currentStepId: null,
          lastConfirmedStepId: checkpoint.steps.at(-1)?.id ?? null,
          completedAt: NOW.toISOString()
        };
      }
      if (outcome === "images_required") {
        return {
          ...checkpoint,
          status: "images_required",
          pauseReason: "images_required",
          currentStepId,
          steps: checkpoint.steps.map((step, index) => index === 0 ? { ...step, status: "images_required" } : step) as ContactStep[]
        };
      }
      if (outcome === "ambiguous") {
        return {
          ...checkpoint,
          status: "paused",
          pauseReason: "verification_pending",
          currentStepId,
          steps: checkpoint.steps.map((step, index) => index === 0 ? {
            ...step,
            status: "verification_pending",
            verification: { outcome: "ambiguous", method: "fake-ambiguous", observedAt: NOW.toISOString(), sendAttempted: true }
          } : step) as ContactStep[]
        };
      }
      if (outcome === "failed") {
        return {
          ...checkpoint,
          status: "failed",
          pauseReason: "non_recoverable_error",
          currentStepId,
          error: { code: ERROR_CODES.invalidContact, message: "Contacto inválido", recoverable: false }
        };
      }
      if (outcome === "capability_break") {
        return {
          ...checkpoint,
          status: "failed",
          pauseReason: "non_recoverable_error",
          currentStepId,
          error: {
            code: ERROR_CODES.selectorStrategyExhausted,
            message: "Capability no resoluble",
            recoverable: false,
            details: { failedCapability: "attachment_action" }
          }
        };
      }
      if (["reloading", "tab_closed", "session_closed"].includes(outcome)) {
        const code = outcome === "reloading"
          ? ERROR_CODES.interfaceLoading
          : outcome === "tab_closed"
            ? ERROR_CODES.whatsappNotOpen
            : ERROR_CODES.sessionNotReady;
        return {
          ...checkpoint,
          status: "paused",
          pauseReason: "max_attempts",
          currentStepId,
          error: { code, message: outcome, recoverable: true }
        };
      }
      return { ...checkpoint, status: "paused", pauseReason: "max_attempts", currentStepId };
    } finally {
      this.concurrent -= 1;
    }
  }
}

function initialCampaign(
  total: number,
  policy: Partial<CampaignPolicyConfig> = {},
  daily: DailyLimitState = refreshDailyLimit(null, policy.dailyContactLimit ?? 1_000, NOW)
): CampaignState {
  const validated = validateCampaignInput({
    campaignId: "campaign-1",
    campaignName: "Campaña de prueba",
    createdBy: "tests",
    recipients: Array.from({ length: total }, (_, index) => ({
      recipientId: `contact-${index + 1}`,
      name: `Cliente ${index + 1}`,
      phone: `54911123456${String(index).padStart(2, "0")}`,
      source: "flor_mia"
    })),
    message: "Hola",
    imageCount: 1,
    imageOrder: [1],
    images: [{ order: 1, name: "flor.png", type: "image/png", size: 3, data: new Uint8Array([1, 2, 3]).buffer }],
    totalRecipients: total
  });
  return createCampaignState(validated, { ...DEFAULT_CAMPAIGN_POLICY, delayBetweenContactsMs: 0, delayBetweenBatchesMs: 0, ...policy }, daily, NOW.toISOString());
}

function setup(total: number, policy: Partial<CampaignPolicyConfig> = {}) {
  const campaigns = new MemoryCampaignStore();
  const checkpoints = new MemoryCheckpointStore();
  const daily = new MemoryDailyLimit();
  const runner = new FakeContactRunner();
  const campaign = initialCampaign(total, policy);
  campaigns.active = campaign;
  daily.state = campaign.dailyLimit;
  const engine = new CampaignEngine({
    campaigns,
    dailyLimit: daily,
    contactCheckpoints: checkpoints,
    contactRunner: runner,
    now: () => new Date(NOW)
  });
  return { campaigns, checkpoints, daily, runner, engine, campaign };
}

async function startAndAdvance(engine: CampaignEngine, times: number): Promise<CampaignState> {
  let state = await engine.start("campaign-1");
  for (let index = 0; index < times; index += 1) state = await engine.advance("campaign-1");
  return state;
}

describe("multi-contact CampaignEngine", () => {
  it("processes three recipients sequentially in received order", async () => {
    const { engine, runner } = setup(3);
    const result = await startAndAdvance(engine, 3);
    expect(result.status).toBe("completed");
    expect(runner.calls).toEqual(["contact-1", "contact-2", "contact-3"]);
  });

  it("reports progress as 1/3, 2/3 and 3/3", async () => {
    const { engine } = setup(3);
    await engine.start("campaign-1");
    const one = await engine.advance("campaign-1");
    const two = await engine.advance("campaign-1");
    const three = await engine.advance("campaign-1");
    expect([one, two, three].map(progressForCampaign)).toEqual([
      { completed: 1, total: 3, percentage: 33.33 },
      { completed: 2, total: 3, percentage: 66.67 },
      { completed: 3, total: 3, percentage: 100 }
    ]);
  });

  it("does not advance when contact 2 is paused", async () => {
    const { engine, runner } = setup(3);
    runner.outcomes.set("contact-2", ["paused"]);
    await startAndAdvance(engine, 2);
    const blocked = await engine.advance("campaign-1");
    expect(blocked.status).toBe("paused");
    expect(runner.calls).toEqual(["contact-1", "contact-2"]);
    expect(blocked.recipients[2]?.status).toBe("pending");
  });

  it("resumes contact 2 without repeating contact 1", async () => {
    const { engine, runner } = setup(3);
    runner.outcomes.set("contact-2", ["paused", "completed"]);
    await startAndAdvance(engine, 2);
    await engine.resume("campaign-1");
    await engine.advance("campaign-1");
    const completed = await engine.advance("campaign-1");
    expect(completed.status).toBe("completed");
    expect(runner.calls).toEqual(["contact-1", "contact-2", "contact-2", "contact-3"]);
  });

  it("honors a manual pause requested during a contact", async () => {
    const { engine, runner } = setup(2);
    let requested = false;
    runner.onRun = async () => {
      if (!requested) {
        requested = true;
        await engine.requestPause("campaign-1");
      }
    };
    const result = await startAndAdvance(engine, 1);
    expect(result.status).toBe("paused");
    expect(result.completedRecipients).toBe(0);
    expect(runner.calls).toEqual(["contact-1"]);
  });

  it("uses a batch pause after each group of three", async () => {
    const { engine } = setup(6, { contactsPerBatch: 3, delayBetweenBatchesMs: 15_000 });
    await engine.start("campaign-1");
    await engine.advance("campaign-1");
    await engine.advance("campaign-1");
    const batchPause = await engine.advance("campaign-1");
    expect(batchPause.status).toBe("waiting_batch");
    expect(batchPause.wait?.kind).toBe("between_batches");
    expect(Date.parse(batchPause.wait!.until) - Date.parse(batchPause.wait!.scheduledAt)).toBe(15_000);
  });

  it("blocks the next recipient after the daily limit, never the active one", async () => {
    const { engine, daily, runner } = setup(2, { dailyContactLimit: 1_000 });
    daily.state = {
      ...refreshDailyLimit(null, 1_000, NOW),
      completedToday: 999,
      remaining: 1,
      countedContactKeys: Array.from({ length: 999 }, (_, index) => `old-${index}`)
    };
    const result = await startAndAdvance(engine, 1);
    expect(result.status).toBe("daily_limit_reached");
    expect(result.completedRecipients).toBe(1);
    expect(runner.calls).toEqual(["contact-1"]);
  });

  it("survives engine recreation without restarting from contact 1", async () => {
    const setupState = setup(2);
    await startAndAdvance(setupState.engine, 1);
    const recovered = new CampaignEngine({
      campaigns: setupState.campaigns,
      dailyLimit: setupState.daily,
      contactCheckpoints: setupState.checkpoints,
      contactRunner: setupState.runner,
      now: () => new Date(NOW)
    });
    const result = await recovered.advance("campaign-1");
    expect(result.status).toBe("completed");
    expect(setupState.runner.calls).toEqual(["contact-1", "contact-2"]);
  });

  it("recovers an interrupted active contact conservatively after a Service Worker restart", async () => {
    const setupState = setup(2);
    let running = await setupState.engine.start("campaign-1");
    running = {
      ...running,
      status: "running",
      activeContactId: "contact-1",
      currentRecipientIndex: 0,
      recipients: running.recipients.map((recipient, index) => index === 0 ? { ...recipient, status: "active" } : recipient)
    };
    setupState.campaigns.active = running;
    const checkpoint = createContactCheckpoint({
      campaignId: running.campaignId,
      campaignName: running.campaignName,
      contact: {
        contactId: "contact-1",
        name: "Cliente 1",
        phoneDigits: running.recipients[0]!.phoneDigits,
        maskedPhone: running.recipients[0]!.maskedPhone
      },
      images: running.images,
      text: running.text,
      now: NOW.toISOString()
    });
    checkpoint.status = "paused";
    checkpoint.pauseReason = "verification_pending";
    checkpoint.currentStepId = checkpoint.steps[0]!.id;
    checkpoint.steps[0] = {
      ...checkpoint.steps[0]!,
      status: "verification_pending",
      verification: { outcome: "ambiguous", method: "service-worker-rehydration", observedAt: NOW.toISOString(), sendAttempted: true }
    };
    setupState.checkpoints.active = checkpoint;

    const recovered = await setupState.engine.recoverAfterServiceWorkerRestart(running, checkpoint);
    expect(recovered.status).toBe("paused");
    expect(recovered.blockReason?.code).toBe("contact_ambiguous");
    expect(recovered.activeContactId).toBe("contact-1");
    expect(recovered.recipients[1]?.status).toBe("pending");
    expect(setupState.runner.calls).toEqual([]);
  });

  it("stops manually without processing future recipients", async () => {
    const { engine, runner } = setup(3);
    await engine.start("campaign-1");
    const stopped = await engine.requestStop("campaign-1");
    const result = await engine.advance("campaign-1");
    expect(stopped.status).toBe("stopped");
    expect(result.status).toBe("stopped");
    expect(runner.calls).toEqual([]);
  });

  it("confirms an active stop only after the contact reaches a safe boundary", async () => {
    const { engine, runner } = setup(2);
    let requested = false;
    runner.onRun = async () => {
      if (!requested) {
        requested = true;
        await engine.requestStop("campaign-1");
      }
    };
    const result = await startAndAdvance(engine, 1);
    expect(result.status).toBe("stopped");
    expect(result.completedRecipients).toBe(0);
    expect(runner.calls).toEqual(["contact-1"]);
  });

  it("propagates images_required and blocks the following recipient", async () => {
    const { engine, runner } = setup(2);
    runner.outcomes.set("contact-1", ["images_required"]);
    const result = await startAndAdvance(engine, 1);
    expect(result.status).toBe("images_required");
    expect(result.recipients[1]?.status).toBe("pending");
    expect(runner.calls).toEqual(["contact-1"]);
  });

  it("propagates ambiguous verification without duplicating or advancing", async () => {
    const { engine, runner } = setup(2);
    runner.outcomes.set("contact-1", ["ambiguous"]);
    const result = await startAndAdvance(engine, 1);
    expect(result.status).toBe("paused");
    expect(result.blockReason?.code).toBe("contact_ambiguous");
    expect(runner.calls).toEqual(["contact-1"]);
  });

  it("pauses on a capability break during a contact and never advances", async () => {
    const { engine, runner } = setup(2);
    runner.outcomes.set("contact-1", ["capability_break"]);
    const result = await startAndAdvance(engine, 1);
    expect(result.status).toBe("paused");
    expect(result.pauseRequested).toBe(true);
    expect(result.blockReason?.code).toBe("whatsapp_ui_changed");
    expect(result.recipients[1]?.status).toBe("pending");
    expect(runner.calls).toEqual(["contact-1"]);
  });

  it("integrates a failed lightweight health check before starting the next recipient", async () => {
    const state = setup(2);
    const engine = new CampaignEngine({
      campaigns: state.campaigns,
      dailyLimit: state.daily,
      contactCheckpoints: state.checkpoints,
      contactRunner: state.runner,
      healthCheck: async () => ({
        healthy: false,
        error: { code: ERROR_CODES.preflightFailed, message: "Selector agotado", recoverable: true },
        message: "Health check incompatible"
      }),
      now: () => new Date(NOW)
    });
    await engine.start("campaign-1");
    const result = await engine.advance("campaign-1");
    expect(result.status).toBe("paused");
    expect(result.blockReason?.code).toBe("whatsapp_ui_changed");
    expect(state.runner.calls).toEqual([]);
  });

  it.each([
    ["reloading", "whatsapp_reloading"],
    ["tab_closed", "whatsapp_tab_closed"],
    ["session_closed", "whatsapp_session_closed"]
  ] as const)("classifies WhatsApp %s and blocks the following recipient", async (outcome, expectedCode) => {
    const { engine, runner } = setup(2);
    runner.outcomes.set("contact-1", [outcome]);
    const result = await startAndAdvance(engine, 1);
    expect(result.status).toBe("paused");
    expect(result.blockReason?.code).toBe(expectedCode);
    expect(result.recipients[1]?.status).toBe("pending");
    expect(runner.calls).toEqual(["contact-1"]);
  });

  it("never counts a partially processed contact in percentage", async () => {
    const { engine, runner } = setup(2);
    runner.outcomes.set("contact-1", ["paused"]);
    const result = await startAndAdvance(engine, 1);
    expect(progressForCampaign(result)).toEqual({ completed: 0, total: 2, percentage: 0 });
  });
});
