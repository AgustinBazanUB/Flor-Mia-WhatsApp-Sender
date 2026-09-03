import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeWhatsAppContactAdapter } from "../src/background/contact-adapter";
import { INTERNAL_MESSAGE_TYPES } from "../src/shared/protocol";
import type { StepExecutionContext, TextContactStep } from "../src/engine/types";

function textStep(): TextContactStep {
  return {
    id: "text",
    operationId: "campaign:contact:text",
    position: 4,
    kind: "text",
    status: "in_progress",
    attempts: 1,
    text: "Hola desde Flor Mía"
  };
}

function executionContext(): StepExecutionContext {
  return {
    checkpoint: {
      schemaVersion: 1,
      checkpointId: "checkpoint",
      campaignId: "campaign",
      campaignName: "Campaign",
      contact: {
        contactId: "contact",
        phoneDigits: "5491112345678",
        maskedPhone: "+54*******5678"
      },
      steps: [],
      status: "running",
      currentStepId: "text",
      lastConfirmedStepId: "image-3",
      openConversationAttempts: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      history: []
    },
    timeoutMs: 30_000,
    imageLoadTimeoutMs: 15_000,
    previewTimeoutMs: 20_000
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("post-media text settle", () => {
  it("waits 1.5 seconds after the last confirmed image before dispatching text", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue({
      success: true,
      completedAt: new Date(0).toISOString(),
      verification: {
        sent: true,
        confirmed: true,
        outcome: "confirmed_strong",
        confidence: "strong",
        method: "test-text-proof",
        observedAt: new Date(0).toISOString()
      }
    });
    const adapter = new ChromeWhatsAppContactAdapter({ getImage: vi.fn() } as never, { send } as never, null, null);
    (adapter as unknown as { whatsappTabId: number | null }).whatsappTabId = 7;

    const pending = adapter.sendText(textStep(), executionContext());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(INTERNAL_MESSAGE_TYPES.whatsappSendText);
    expect(result).toMatchObject({
      outcome: "confirmed",
      verification: { details: { postMediaTextSettleMs: 1_500 } }
    });
  });
});
