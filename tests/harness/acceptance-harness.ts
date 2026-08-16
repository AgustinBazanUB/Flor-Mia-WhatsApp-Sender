import { processContact } from "../../src/engine/contact-engine";
import { createContactCheckpoint } from "../../src/engine/steps";
import type { RetryPolicyConfig } from "../../src/engine/retry-policy";
import type {
  ContactAdapter,
  ContactCheckpointRepository,
  ContactProcessCheckpoint,
  ContactStep,
  ImageContactStep,
  StepExecutionResult,
  StepReconciliationResult,
  TextContactStep
} from "../../src/engine/types";
import type { CampaignWakeupScheduler } from "../../src/campaign/scheduler";
import { ERROR_CODES } from "../../src/shared/errors";

export type SimulatedWhatsAppCondition = "healthy" | "offline" | "reload" | "selector_break";

export class FakeCampaignClock {
  constructor(private instant = new Date("2026-08-16T12:00:00.000Z")) {}
  now = (): Date => new Date(this.instant);
  nowIso = (): string => this.instant.toISOString();
  advance(ms: number): void { this.instant = new Date(this.instant.getTime() + ms); }
}

export class FakeCampaignAlarms implements CampaignWakeupScheduler {
  scheduled = new Map<string, number>();
  async schedule(campaignId: string, runToken: string, when: number): Promise<void> { this.scheduled.set(`${campaignId}:${runToken}`, when); }
  async cancel(campaignId: string, runToken: string): Promise<void> { this.scheduled.delete(`${campaignId}:${runToken}`); }
}

interface CheckpointSlot { active: ContactProcessCheckpoint | null }

export class RestartableCheckpointStore implements ContactCheckpointRepository {
  constructor(private readonly slot: CheckpointSlot = { active: null }) {}
  async loadActive() { return this.slot.active; }
  async saveActive(checkpoint: ContactProcessCheckpoint) { this.slot.active = checkpoint; return checkpoint; }
  async clearActive() { this.slot.active = null; }
  restart(): RestartableCheckpointStore { return new RestartableCheckpointStore(this.slot); }
}

function confirmed(stepId: string) {
  return {
    outcome: "confirmed" as const,
    method: "fake-outgoing-dom",
    observedAt: "2026-08-16T12:00:00.000Z",
    sendAttempted: true,
    outgoingMessageId: `outgoing-${stepId}`
  };
}

export class FakeWhatsAppAdapter implements ContactAdapter {
  calls: string[] = [];
  condition: SimulatedWhatsAppCondition = "healthy";
  failImageOnce: string | null = null;
  private failed = new Set<string>();

  async openConversation(): Promise<void> { this.calls.push("open"); }

  private simulatedFailure(): StepExecutionResult | null {
    if (this.condition === "healthy") return null;
    const code = this.condition === "reload"
      ? ERROR_CODES.interfaceLoading
      : this.condition === "selector_break"
        ? ERROR_CODES.selectorStrategyExhausted
        : ERROR_CODES.timeout;
    return {
      outcome: "failed",
      error: { code, message: `Simulated ${this.condition}`, recoverable: this.condition !== "selector_break" },
      recoverable: this.condition !== "selector_break",
      sendAttempted: false
    };
  }

  async sendImage(step: ImageContactStep): Promise<StepExecutionResult> {
    this.calls.push(step.id);
    const failure = this.simulatedFailure();
    if (failure) return failure;
    if (this.failImageOnce === step.id && !this.failed.has(step.id)) {
      this.failed.add(step.id);
      return {
        outcome: "failed",
        error: { code: ERROR_CODES.imageLoadFailed, message: "Simulated image failure", recoverable: true },
        recoverable: true,
        sendAttempted: false
      };
    }
    return { outcome: "confirmed", verification: confirmed(step.id) };
  }

  async sendText(step: TextContactStep): Promise<StepExecutionResult> {
    this.calls.push(step.id);
    const failure = this.simulatedFailure();
    return failure ?? { outcome: "confirmed", verification: confirmed(step.id) };
  }

  async reconcile(step: ContactStep): Promise<StepReconciliationResult> {
    this.calls.push(`reconcile:${step.id}`);
    return {
      outcome: "ambiguous",
      verification: { outcome: "ambiguous", method: "fake-reconcile", observedAt: "2026-08-16T12:00:00.000Z", sendAttempted: true }
    };
  }
}

const TEST_POLICY: RetryPolicyConfig = {
  maxAttemptsPerStep: 3,
  backoff: { initialDelayMs: 0, multiplier: 1, maxDelayMs: 0 },
  timeouts: { openConversationMs: 1, imageLoadMs: 1, previewMs: 1, confirmationMs: 1, composerMs: 1, reconciliationMs: 1 }
};

export function acceptanceCheckpoint(imageCount: number, text = "Mensaje autorizado"): ContactProcessCheckpoint {
  return createContactCheckpoint({
    campaignId: "acceptance-campaign",
    campaignName: "Acceptance",
    contact: { contactId: "recipient-1", phoneDigits: "5491112345678", maskedPhone: "+54••••••78" },
    images: Array.from({ length: imageCount }, (_, index) => ({
      imageId: `asset-${index + 1}`,
      order: index + 1,
      name: `image-${index + 1}.png`,
      type: "image/png",
      size: 3
    })),
    text,
    now: "2026-08-16T12:00:00.000Z"
  });
}

export async function runAcceptanceContact(
  imageCount: number,
  adapter = new FakeWhatsAppAdapter(),
  store = new RestartableCheckpointStore()
) {
  const result = await processContact(acceptanceCheckpoint(imageCount), {
    adapter,
    store,
    policy: TEST_POLICY,
    now: () => "2026-08-16T12:00:01.000Z",
    sleep: async () => undefined
  });
  return { result, adapter, store };
}
