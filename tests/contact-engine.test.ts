import { describe, expect, it } from "vitest";
import { processContact } from "../src/engine/contact-engine";
import { createContactCheckpoint } from "../src/engine/steps";
import type { RetryPolicyConfig } from "../src/engine/retry-policy";
import type {
  ContactAdapter,
  ContactCheckpointRepository,
  ContactProcessCheckpoint,
  ContactStep,
  ImageContactStep,
  StepExecutionResult,
  StepReconciliationResult,
  StepVerification,
  TextContactStep
} from "../src/engine/types";
import { ERROR_CODES, ExtensionError, type SerializedExtensionError } from "../src/shared/errors";

const POLICY: RetryPolicyConfig = {
  maxAttemptsPerStep: 3,
  backoff: { initialDelayMs: 0, multiplier: 1, maxDelayMs: 0 },
  timeouts: {
    openConversationMs: 1,
    imageLoadMs: 1,
    previewMs: 1,
    confirmationMs: 1,
    composerMs: 1,
    reconciliationMs: 1
  }
};

function verification(method: string): StepVerification {
  return {
    outcome: "confirmed",
    method,
    observedAt: "2026-08-15T00:00:00.000Z",
    sendAttempted: true,
    outgoingMessageId: `outgoing-${method}`
  };
}

function recoverableError(message: string): SerializedExtensionError {
  return { code: ERROR_CODES.imageLoadFailed, message, recoverable: true };
}

class MemoryCheckpointStore implements ContactCheckpointRepository {
  active: ContactProcessCheckpoint | null = null;

  async loadActive(): Promise<ContactProcessCheckpoint | null> { return this.active; }
  async saveActive(checkpoint: ContactProcessCheckpoint): Promise<ContactProcessCheckpoint> {
    this.active = checkpoint;
    return checkpoint;
  }
  async clearActive(): Promise<void> { this.active = null; }
}

class FakeAdapter implements ContactAdapter {
  readonly calls: string[] = [];
  readonly remainingFailures = new Map<string, number>();
  readonly missing = new Set<string>();
  remainingOpenFailures = 0;
  ambiguousStep: string | null = null;
  reconciliation: StepReconciliationResult = {
    outcome: "ambiguous",
    verification: {
      outcome: "ambiguous",
      method: "test-still-ambiguous",
      observedAt: "2026-08-15T00:00:00.000Z",
      sendAttempted: true
    }
  };

  async openConversation(): Promise<void> {
    this.calls.push("open");
    if (this.remainingOpenFailures > 0) {
      this.remainingOpenFailures -= 1;
      throw new ExtensionError(ERROR_CODES.timeout, "La conversación no abrió a tiempo.");
    }
  }

  async sendImage(step: ImageContactStep): Promise<StepExecutionResult> {
    this.calls.push(step.id);
    if (this.missing.has(step.id)) {
      return { outcome: "missing_resource", error: recoverableError("Falta la imagen temporal") };
    }
    const remaining = this.remainingFailures.get(step.id) ?? 0;
    if (remaining > 0) {
      this.remainingFailures.set(step.id, remaining === Number.POSITIVE_INFINITY ? remaining : remaining - 1);
      return { outcome: "failed", error: recoverableError("Fallo simulado"), recoverable: true, sendAttempted: false };
    }
    if (this.ambiguousStep === step.id) {
      this.ambiguousStep = null;
      return {
        outcome: "ambiguous",
        verification: {
          outcome: "ambiguous",
          method: "test-send-without-confirmation",
          observedAt: "2026-08-15T00:00:00.000Z",
          sendAttempted: true,
          baselineOutgoingIds: ["before-1"]
        }
      };
    }
    return { outcome: "confirmed", verification: verification(step.id) };
  }

  async sendText(step: TextContactStep): Promise<StepExecutionResult> {
    this.calls.push(step.id);
    return { outcome: "confirmed", verification: verification(step.id) };
  }

  async reconcile(step: ContactStep): Promise<StepReconciliationResult> {
    this.calls.push(`reconcile:${step.id}`);
    return this.reconciliation;
  }
}

function checkpoint(imageCount: number, text = "Hola Flor Mía"): ContactProcessCheckpoint {
  return createContactCheckpoint({
    campaignId: "campaign-1",
    campaignName: "Prueba",
    contact: { contactId: "contact-1", phoneDigits: "5491112345678", maskedPhone: "+54••••••5678" },
    images: Array.from({ length: imageCount }, (_, index) => ({
      imageId: `asset-${index + 1}`,
      order: index + 1,
      name: `imagen-${index + 1}.png`,
      type: "image/png",
      size: 100 + index
    })),
    text,
    now: "2026-08-15T00:00:00.000Z"
  });
}

async function run(
  initial: ContactProcessCheckpoint,
  adapter: FakeAdapter,
  store = new MemoryCheckpointStore()
): Promise<ContactProcessCheckpoint> {
  return processContact(initial, {
    adapter,
    store,
    policy: POLICY,
    now: () => "2026-08-15T00:00:01.000Z",
    sleep: async () => undefined
  });
}

describe("atomic contact engine", () => {
  it("retries opening the conversation before executing the first step", async () => {
    const adapter = new FakeAdapter();
    adapter.remainingOpenFailures = 1;
    const result = await run(checkpoint(0), adapter);

    expect(result.status).toBe("completed");
    expect(adapter.calls).toEqual(["open", "open", "text"]);
    expect(result.openConversationAttempts).toBe(2);
  });

  it("can resume after the conversation-opening retry window is exhausted", async () => {
    const store = new MemoryCheckpointStore();
    const adapter = new FakeAdapter();
    adapter.remainingOpenFailures = 3;
    const paused = await run(checkpoint(0), adapter, store);

    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("open_conversation_failed");
    expect(paused.steps[0]?.attempts).toBe(0);

    const resumed = await run(paused, adapter, store);
    expect(resumed.status).toBe("completed");
    expect(resumed.openConversationAttempts).toBe(4);
    expect(adapter.calls.filter((call) => call === "text")).toHaveLength(1);
  });

  it("processes text-only contact and verifies the outgoing step", async () => {
    const adapter = new FakeAdapter();
    const result = await run(checkpoint(0), adapter);

    expect(result.status).toBe("completed");
    expect(result.steps.map((step) => step.status)).toEqual(["confirmed"]);
    expect(adapter.calls).toEqual(["open", "text"]);
  });

  it("sends one image before text", async () => {
    const adapter = new FakeAdapter();
    const result = await run(checkpoint(1), adapter);

    expect(result.status).toBe("completed");
    expect(adapter.calls).toEqual(["open", "image-1", "text"]);
  });

  it("sends three images in order and text last", async () => {
    const adapter = new FakeAdapter();
    const result = await run(checkpoint(3), adapter);

    expect(result.status).toBe("completed");
    expect(adapter.calls).toEqual(["open", "image-1", "image-2", "image-3", "text"]);
    expect(result.lastConfirmedStepId).toBe("text");
  });

  it("retries image 2 once without repeating image 1", async () => {
    const adapter = new FakeAdapter();
    adapter.remainingFailures.set("image-2", 1);
    const result = await run(checkpoint(3), adapter);

    expect(result.status).toBe("completed");
    expect(adapter.calls).toEqual(["open", "image-1", "image-2", "image-2", "image-3", "text"]);
    expect(result.steps.find((step) => step.id === "image-2")?.attempts).toBe(2);
  });

  it("pauses after three failures on image 2 and blocks later steps", async () => {
    const adapter = new FakeAdapter();
    adapter.remainingFailures.set("image-2", Number.POSITIVE_INFINITY);
    const result = await run(checkpoint(3), adapter);

    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("max_attempts");
    expect(adapter.calls).toEqual(["open", "image-1", "image-2", "image-2", "image-2"]);
    expect(result.steps.find((step) => step.id === "image-3")?.status).toBe("pending");
    expect(result.steps.find((step) => step.id === "text")?.attempts).toBe(0);
  });

  it("opens a fresh retry window after an explicit max-attempts resume", async () => {
    const store = new MemoryCheckpointStore();
    const adapter = new FakeAdapter();
    adapter.remainingFailures.set("image-2", Number.POSITIVE_INFINITY);
    const paused = await run(checkpoint(2), adapter, store);
    adapter.remainingFailures.delete("image-2");

    const resumed = await run(paused, adapter, store);
    expect(resumed.status).toBe("completed");
    expect(resumed.steps.find((step) => step.id === "image-1")?.attempts).toBe(1);
    expect(resumed.steps.find((step) => step.id === "image-2")?.attempts).toBe(4);
    expect(adapter.calls.filter((call) => call === "image-1")).toHaveLength(1);
  });

  it("applies a cooperative pause only after the current verified step", async () => {
    const store = new MemoryCheckpointStore();
    const adapter = new FakeAdapter();
    const result = await processContact(checkpoint(2), {
      adapter,
      store,
      policy: POLICY,
      sleep: async () => undefined,
      shouldPause: () => adapter.calls.includes("image-1")
    });
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("manual_pause");
    expect(result.steps.find((step) => step.id === "image-1")?.status).toBe("confirmed");
    expect(adapter.calls).toEqual(["open", "image-1"]);
  });

  it("pauses before a click when the request already exists at a safe boundary", async () => {
    const adapter = new FakeAdapter();
    const result = await processContact(checkpoint(1), {
      adapter,
      store: new MemoryCheckpointStore(),
      policy: POLICY,
      sleep: async () => undefined,
      shouldPause: () => true
    });
    expect(result.status).toBe("paused");
    expect(result.steps.every((step) => step.attempts === 0)).toBe(true);
    expect(adapter.calls).toEqual(["open"]);
  });

  it("resumes from image 3 after a persisted image-2 checkpoint", async () => {
    const initial = checkpoint(3);
    const confirmed = initial.steps.map((step) => step.position <= 2
      ? { ...step, status: "confirmed" as const, attempts: 1, verification: verification(step.id) }
      : step);
    const resumed: ContactProcessCheckpoint = {
      ...initial,
      status: "paused",
      pauseReason: "max_attempts",
      currentStepId: "image-3",
      lastConfirmedStepId: "image-2",
      openConversationAttempts: 1,
      steps: confirmed
    };
    const store = new MemoryCheckpointStore();
    store.active = resumed;
    const adapter = new FakeAdapter();
    const result = await run(resumed, adapter, store);

    expect(result.status).toBe("completed");
    expect(adapter.calls).toEqual(["open", "image-3", "text"]);
  });

  it("does not duplicate an ambiguous image until DOM reconciliation confirms it", async () => {
    const store = new MemoryCheckpointStore();
    const adapter = new FakeAdapter();
    adapter.ambiguousStep = "image-1";
    const first = await run(checkpoint(1), adapter, store);

    expect(first.status).toBe("paused");
    expect(first.pauseReason).toBe("verification_pending");
    expect(adapter.calls.filter((call) => call === "image-1")).toHaveLength(1);

    const second = await run(first, adapter, store);
    expect(second.status).toBe("paused");
    expect(adapter.calls.filter((call) => call === "image-1")).toHaveLength(1);
    expect(adapter.calls).toContain("reconcile:image-1");

    adapter.reconciliation = { outcome: "confirmed", verification: verification("reconciled-image-1") };
    const third = await run(second, adapter, store);
    expect(third.status).toBe("completed");
    expect(adapter.calls.filter((call) => call === "image-1")).toHaveLength(1);
    expect(adapter.calls.at(-1)).toBe("text");
  });

  it("honors the durable pre-click marker when the tab response is lost", async () => {
    const store = new MemoryCheckpointStore();
    const initial = checkpoint(1);
    const adapter: ContactAdapter = {
      async openConversation() { /* ready */ },
      async sendImage(step) {
        const active = await store.loadActive();
        if (!active) throw new Error("checkpoint missing");
        await store.saveActive({
          ...active,
          steps: active.steps.map((candidate) => candidate.id === step.id
            ? {
                ...candidate,
                verification: {
                  outcome: "ambiguous" as const,
                  method: "send-attempted-checkpoint",
                  observedAt: "2026-08-15T00:00:01.000Z",
                  sendAttempted: true,
                  baselineOutgoingIds: ["before-1"]
                }
              }
            : candidate)
        });
        return { outcome: "failed", error: recoverableError("El puerto del tab se cerró"), recoverable: true, sendAttempted: false };
      },
      async sendText() { return { outcome: "confirmed", verification: verification("text") }; },
      async reconcile() {
        return {
          outcome: "ambiguous",
          verification: {
            outcome: "ambiguous",
            method: "unused",
            observedAt: "2026-08-15T00:00:01.000Z",
            sendAttempted: true
          }
        };
      }
    };

    const result = await processContact(initial, {
      adapter,
      store,
      policy: POLICY,
      sleep: async () => undefined
    });
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("verification_pending");
    expect(result.steps[0]).toMatchObject({ status: "verification_pending", attempts: 1 });
    expect(result.steps[1]?.attempts).toBe(0);
  });

  it("preserves a missing-image checkpoint and continues after re-selection", async () => {
    const store = new MemoryCheckpointStore();
    const adapter = new FakeAdapter();
    adapter.missing.add("image-1");
    const first = await run(checkpoint(1), adapter, store);

    expect(first.status).toBe("images_required");
    expect(first.steps[0]?.status).toBe("images_required");
    expect(first.steps[1]?.attempts).toBe(0);

    adapter.missing.delete("image-1");
    const resumed = await run(first, adapter, store);
    expect(resumed.status).toBe("completed");
    expect(resumed.steps.map((step) => step.status)).toEqual(["confirmed", "confirmed"]);
  });
});
