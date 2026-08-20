import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeWhatsAppContactAdapter } from "../src/background/contact-adapter";
import type { ImageContactStep, StepExecutionContext } from "../src/engine/types";

function imageStep(order: number): ImageContactStep {
  return {
    id: `image-${order}`,
    operationId: `campaign:contact:image-${order}`,
    position: order,
    kind: "image",
    status: "in_progress",
    attempts: 1,
    image: {
      imageId: `image-${order}`,
      order,
      name: `image-${order}.jpg`,
      type: "image/jpeg",
      size: 2
    }
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
      currentStepId: null,
      lastConfirmedStepId: null,
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

function createAdapter() {
  const send = vi.fn().mockResolvedValue({
    verification: {
      outcome: "confirmed",
      confidence: "strong",
      method: "test-photo-proof",
      observedAt: new Date(0).toISOString(),
      sendAttempted: true,
      details: {}
    }
  });
  const blobs = {
    getImage: vi.fn().mockImplementation(async (_campaignId: string, imageId: string) => ({
      key: `campaign:${imageId}`,
      campaignId: "campaign",
      imageId,
      order: 1,
      name: `${imageId}.jpg`,
      type: "image/jpeg",
      blob: new Blob([new Uint8Array([1, 2])], { type: "image/jpeg" }),
      createdAt: new Date(0).toISOString()
    }))
  };
  const adapter = new ChromeWhatsAppContactAdapter(blobs as never, { send } as never, null, null);
  (adapter as unknown as { whatsappTabId: number | null }).whatsappTabId = 7;
  return { adapter, send };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("image settle timing", () => {
  it("waits one second before the first image and caps image confirmation at eight seconds", async () => {
    vi.useFakeTimers();
    const { adapter, send } = createAdapter();
    const pending = adapter.sendImage(imageStep(1), executionContext());
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(999);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ confirmationTimeoutMs: 8_000 });
    expect(result).toMatchObject({
      outcome: "confirmed",
      verification: {
        details: {
          imageOrder: 1,
          preSendSettleMs: 1_000,
          imageConfirmationTimeoutMs: 8_000
        }
      }
    });
  });

  it("waits half a second before subsequent images", async () => {
    vi.useFakeTimers();
    const { adapter, send } = createAdapter();
    const pending = adapter.sendImage(imageStep(2), executionContext());
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(499);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "confirmed",
      verification: {
        details: {
          imageOrder: 2,
          preSendSettleMs: 500
        }
      }
    });
  });
});
