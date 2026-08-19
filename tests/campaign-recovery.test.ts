import { describe, expect, it } from "vitest";
import { CampaignEngine, type CampaignContactRunner } from "../src/campaign/campaign-engine";
import { createCampaignState } from "../src/campaign/campaign-store";
import type {
  CampaignPolicyConfig,
  CampaignRepository,
  CampaignState,
  DailyLimitRepository,
  DailyLimitState
} from "../src/campaign/campaign-types";
import { campaignRecipientCounters, progressForCampaign } from "../src/campaign/progress";
import { refreshDailyLimit, incrementDailyLimit } from "../src/campaign/daily-limit";
import { createContactCheckpoint } from "../src/engine/steps";
import type { ContactCheckpointRepository, ContactProcessCheckpoint, ContactStep } from "../src/engine/types";
import { validateCampaignInput } from "../src/shared/campaign";
import { ERROR_CODES } from "../src/shared/errors";

const NOW = new Date(2026, 7, 19, 16, 0, 0);
const POLICY: CampaignPolicyConfig = {
  contactsPerBatch: 50,
  delayBetweenContactsMs: 0,
  delayBetweenBatchesMs: 0,
  dailyContactLimit: 1_000,
  whatsappLoadWaitMs: 30_000
};

class MemoryCampaigns implements CampaignRepository {
  constructor(public active: CampaignState | null) {}
  async loadActive() { return this.active; }
  async saveActive(campaign: CampaignState) { this.active = campaign; return campaign; }
  async clearActive() { this.active = null; }
}

class MemoryCheckpoints implements ContactCheckpointRepository {
  active: ContactProcessCheckpoint | null = null;
  clearCalls = 0;
  async loadActive() { return this.active; }
  async saveActive(checkpoint: ContactProcessCheckpoint) { this.active = checkpoint; return checkpoint; }
  async clearActive() { this.clearCalls += 1; this.active = null; }
}

class MemoryDaily implements DailyLimitRepository {
  state: DailyLimitState = refreshDailyLimit(null, POLICY.dailyContactLimit, NOW);
  async load(limit: number, now = NOW) {
    this.state = refreshDailyLimit(this.state, limit, now);
    return this.state;
  }
  async recordCompletion(limit: number, key: string, now = NOW) {
    this.state = incrementDailyLimit(await this.load(limit, now), key, now);
    return this.state;
  }
}

type Outcome = "complete" | "timeout";

function confirmedSteps(steps: ContactStep[]): ContactStep[] {
  return steps.map((step) => ({
    ...step,
    status: "confirmed",
    attempts: Math.max(1, step.attempts),
    completedAt: NOW.toISOString(),
    verification: {
      outcome: "confirmed",
      method: "recovery-test",
      observedAt: NOW.toISOString(),
      sendAttempted: true,
      outgoingMessageId: `out-${step.id}`
    }
  })) as ContactStep[];
}

class Runner implements CampaignContactRunner {
  readonly calls: string[] = [];
  readonly outcomes = new Map<string, Outcome>();

  async run(checkpoint: ContactProcessCheckpoint): Promise<ContactProcessCheckpoint> {
    this.calls.push(checkpoint.contact.contactId);
    if (this.outcomes.get(checkpoint.contact.contactId) === "timeout") {
      const currentStepId = checkpoint.steps[0]?.id ?? null;
      return {
        ...checkpoint,
        status: "paused",
        pauseReason: "max_attempts",
        currentStepId,
        openConversationAttempts: 2,
        openConversationFailures: 2,
        error: {
          code: ERROR_CODES.timeout,
          message: "La conversación específica no abrió a tiempo.",
          recoverable: true,
          details: { stage: "open_conversation", sendAttempted: false }
        }
      };
    }
    return {
      ...checkpoint,
      status: "completed",
      currentStepId: null,
      lastConfirmedStepId: checkpoint.steps.at(-1)?.id ?? null,
      steps: confirmedSteps(checkpoint.steps),
      completedAt: NOW.toISOString()
    };
  }
}

function state(total: number): CampaignState {
  const campaign = validateCampaignInput({
    campaignId: "campaign-recovery",
    campaignName: "Recovery",
    createdBy: "tests",
    recipients: Array.from({ length: total }, (_, index) => ({
      recipientId: `contact-${index + 1}`,
      name: `Cliente ${index + 1}`,
      phone: `5491112345${String(index).padStart(3, "0")}`,
      source: "flor_mia" as const
    })),
    message: "Hola",
    imageCount: 0,
    imageOrder: [],
    images: [],
    totalRecipients: total
  });
  return createCampaignState(campaign, POLICY, refreshDailyLimit(null, POLICY.dailyContactLimit, NOW), NOW.toISOString());
}

function setup(total: number) {
  const campaigns = new MemoryCampaigns(state(total));
  const checkpoints = new MemoryCheckpoints();
  const daily = new MemoryDaily();
  const runner = new Runner();
  const engine = new CampaignEngine({
    campaigns,
    contactCheckpoints: checkpoints,
    dailyLimit: daily,
    contactRunner: runner,
    now: () => NOW
  });
  return { campaigns, checkpoints, daily, runner, engine };
}

describe("campaign recovery semantics", () => {
  it("marks a safe local failure terminal after its internal retry budget and continues with the next contact", async () => {
    const test = setup(2);
    test.runner.outcomes.set("contact-1", "timeout");
    await test.engine.start("campaign-recovery");

    const first = await test.engine.advance("campaign-recovery");
    expect(first.status).toBe("waiting_contact");
    expect(first.recipients[0]).toMatchObject({ status: "error", failure: { sendAttempted: false, retryEligible: true } });
    expect(first.recipients[1]?.status).toBe("pending");
    expect(test.daily.state.completedToday).toBe(0);

    const finished = await test.engine.advance("campaign-recovery");
    expect(finished.status).toBe("completed");
    expect(finished.recipients.map((item) => item.status)).toEqual(["error", "completed"]);
    expect(campaignRecipientCounters(finished)).toEqual({ total: 2, processed: 2, sent: 1, failed: 1, remaining: 0 });
    expect(test.daily.state.completedToday).toBe(1);
    expect(test.runner.calls).toEqual(["contact-1", "contact-2"]);
  });

  it("opens the circuit after three consecutive equivalent safe technical failures", async () => {
    const test = setup(4);
    for (const id of ["contact-1", "contact-2", "contact-3"]) test.runner.outcomes.set(id, "timeout");
    await test.engine.start("campaign-recovery");
    await test.engine.advance("campaign-recovery");
    await test.engine.advance("campaign-recovery");
    const paused = await test.engine.advance("campaign-recovery");

    expect(paused.status).toBe("paused");
    expect(paused.blockReason?.code).toBe("repeated_contact_failures");
    expect(paused.failureCircuit).toMatchObject({ consecutive: 3, threshold: 3 });
    expect(paused.recipients.slice(0, 3).every((item) => item.status === "error")).toBe(true);
    expect(paused.recipients[3]?.status).toBe("pending");
    expect(test.daily.state.completedToday).toBe(0);
  });

  it("resets the consecutive failure circuit after a successful recipient", async () => {
    const test = setup(4);
    test.runner.outcomes.set("contact-1", "timeout");
    test.runner.outcomes.set("contact-3", "timeout");
    await test.engine.start("campaign-recovery");
    await test.engine.advance("campaign-recovery");
    const afterSuccess = await test.engine.advance("campaign-recovery");
    expect(afterSuccess.failureCircuit?.consecutive).toBe(0);
    const afterSecondFailure = await test.engine.advance("campaign-recovery");

    expect(afterSecondFailure.status).toBe("waiting_contact");
    expect(afterSecondFailure.failureCircuit?.consecutive).toBe(1);
    expect(afterSecondFailure.blockReason?.code).not.toBe("repeated_contact_failures");
  });

  it("reports processed separately from sent so 97 sent + 3 failed is 100% processed", () => {
    const campaign = state(100);
    campaign.recipients = campaign.recipients.map((recipient, index) => ({
      ...recipient,
      status: index < 97 ? "completed" : "error"
    }));
    campaign.completedRecipients = 97;

    expect(campaignRecipientCounters(campaign)).toEqual({ total: 100, processed: 100, sent: 97, failed: 3, remaining: 0 });
    expect(progressForCampaign(campaign)).toEqual({ completed: 100, total: 100, percentage: 100 });
  });

  it("manual Retry preserves confirmed steps and resets only the safe unfinished step", async () => {
    const test = setup(1);
    let campaign = test.campaigns.active!;
    campaign = {
      ...campaign,
      status: "paused",
      activeContactId: "contact-1",
      currentRecipientIndex: 0,
      recipients: campaign.recipients.map((recipient) => ({ ...recipient, status: "paused" })),
      blockReason: { code: "contact_paused", message: "Retry", at: NOW.toISOString(), recoverable: true }
    };
    test.campaigns.active = campaign;
    const cp = createContactCheckpoint({
      campaignId: campaign.campaignId,
      campaignName: campaign.campaignName,
      contact: { contactId: "contact-1", phoneDigits: campaign.recipients[0]!.phoneDigits, maskedPhone: campaign.recipients[0]!.maskedPhone },
      images: [{ imageId: "image-1", order: 1, name: "a.png", type: "image/png", size: 1 }],
      text: "Hola",
      now: NOW.toISOString()
    });
    cp.status = "paused";
    cp.pauseReason = "max_attempts";
    cp.currentStepId = "text";
    cp.steps[0] = confirmedSteps([cp.steps[0]!])[0]!;
    cp.steps[1] = {
      ...cp.steps[1]!,
      status: "failed",
      attempts: 3,
      error: { code: ERROR_CODES.timeout, message: "Antes del click", recoverable: true, details: { sendAttempted: false } }
    };
    test.checkpoints.active = cp;

    const retried = await test.engine.retry(campaign.campaignId);
    expect(retried.status).toBe("running");
    expect(test.checkpoints.active?.steps[0]?.status).toBe("confirmed");
    expect(test.checkpoints.active?.steps[1]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("never allows direct Retry while send evidence remains ambiguous", async () => {
    const test = setup(1);
    const campaign = test.campaigns.active!;
    test.campaigns.active = {
      ...campaign,
      status: "paused",
      activeContactId: "contact-1",
      currentRecipientIndex: 0,
      recipients: campaign.recipients.map((recipient) => ({ ...recipient, status: "paused" })),
      blockReason: { code: "contact_ambiguous", message: "Ambiguo", at: NOW.toISOString(), recoverable: true }
    };
    const cp = createContactCheckpoint({
      campaignId: campaign.campaignId,
      campaignName: campaign.campaignName,
      contact: { contactId: "contact-1", phoneDigits: campaign.recipients[0]!.phoneDigits, maskedPhone: campaign.recipients[0]!.maskedPhone },
      images: [],
      text: "Hola",
      now: NOW.toISOString()
    });
    cp.status = "paused";
    cp.pauseReason = "verification_pending";
    cp.currentStepId = "text";
    cp.steps[0] = {
      ...cp.steps[0]!,
      status: "verification_pending",
      attempts: 1,
      verification: { outcome: "ambiguous", method: "test", observedAt: NOW.toISOString(), sendAttempted: true }
    };
    test.checkpoints.active = cp;

    await expect(test.engine.retry(campaign.campaignId)).rejects.toMatchObject({ code: ERROR_CODES.ambiguousResult });
  });

  it("Retry Failed reopens only safe terminal errors and never completed recipients", async () => {
    const test = setup(2);
    const campaign = test.campaigns.active!;
    const failedAt = NOW.toISOString();
    test.campaigns.active = {
      ...campaign,
      status: "completed",
      completedAt: failedAt,
      completedRecipients: 1,
      recipients: campaign.recipients.map((recipient, index) => index === 0
        ? { ...recipient, status: "completed", completedAt: failedAt }
        : {
            ...recipient,
            status: "error",
            completedAt: failedAt,
            error: { code: ERROR_CODES.timeout, message: "Falló antes de enviar", recoverable: true },
            failure: {
              errorCode: ERROR_CODES.timeout,
              errorCategory: "TEMPORARY_WHATSAPP_ERROR",
              operation: "open_conversation",
              stage: "open_conversation",
              capability: null,
              attempts: 2,
              sendAttempted: false,
              ambiguous: false,
              reconciled: true,
              retryEligible: true,
              signature: "TIMEOUT|TEMPORARY_WHATSAPP_ERROR|open_conversation|open_conversation|none",
              failedAt
            }
          }),
      currentRecipientIndex: null,
      activeContactId: null
    };

    const retried = await test.engine.retryFailed(campaign.campaignId);
    expect(retried.status).toBe("running");
    expect(retried.retryCycle).toBe(1);
    expect(retried.recipients[0]?.status).toBe("completed");
    expect(retried.recipients[1]?.status).toBe("pending");
    expect(retried.completedRecipients).toBe(1);
  });
});
