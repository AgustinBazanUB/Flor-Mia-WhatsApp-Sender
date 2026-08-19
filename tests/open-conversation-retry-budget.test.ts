import { describe, expect, it } from "vitest";
import { processContact } from "../src/engine/contact-engine";
import { createContactCheckpoint } from "../src/engine/steps";
import type { ContactAdapter, ContactCheckpointRepository, ContactProcessCheckpoint } from "../src/engine/types";
import { ERROR_CODES, ExtensionError } from "../src/shared/errors";

class Store implements ContactCheckpointRepository {
  active: ContactProcessCheckpoint | null = null;
  async loadActive() { return this.active; }
  async saveActive(checkpoint: ContactProcessCheckpoint) { this.active = checkpoint; return checkpoint; }
  async clearActive() { this.active = null; }
}

function initial(): ContactProcessCheckpoint {
  return createContactCheckpoint({
    campaignId: "campaign-proof-budget",
    campaignName: "Proof budget",
    contact: { contactId: "contact-1", phoneDigits: "5491112345678", maskedPhone: "+54••••••5678" },
    images: [],
    text: "Hola"
  });
}

describe("conversation proof retry budget", () => {
  it("runs one no-evidence proof per navigation generation and never grows through repeated Resume", async () => {
    const store = new Store();
    let openCalls = 0;
    const adapter: ContactAdapter = {
      async openConversation() {
        openCalls += 1;
        throw new ExtensionError(ERROR_CODES.contactContextUnverified, "Sin evidencia nueva", {
          recoverable: true,
          details: {
            proofStrategy: "none",
            proofFailureReason: "insufficient_evidence",
            retryWithoutNewEvidence: false
          }
        });
      },
      async sendImage() { throw new Error("should not send"); },
      async sendText() { throw new Error("should not send"); },
      async reconcile() { throw new Error("should not reconcile"); }
    };
    const policy = {
      maxAttemptsPerStep: 3,
      maxOpenConversationAttempts: 2,
      backoff: { initialDelayMs: 0, multiplier: 1, maxDelayMs: 0 },
      timeouts: {
        openConversationMs: 10,
        imageLoadMs: 10,
        previewMs: 10,
        confirmationMs: 10,
        composerMs: 10,
        reconciliationMs: 10
      }
    };

    const first = await processContact(initial(), { adapter, store, policy, sleep: async () => undefined });
    expect(first.status).toBe("paused");
    expect(first.openConversationAttempts).toBe(1);
    expect(first.openConversationFailures).toBe(1);
    expect(openCalls).toBe(1);

    const second = await processContact(first, { adapter, store, policy, sleep: async () => undefined });
    expect(second.status).toBe("paused");
    expect(second.openConversationAttempts).toBe(2);
    expect(second.openConversationFailures).toBe(2);
    expect(openCalls).toBe(2);

    const third = await processContact(second, { adapter, store, policy, sleep: async () => undefined });
    expect(third.status).toBe("paused");
    expect(third.openConversationAttempts).toBe(2);
    expect(third.openConversationFailures).toBe(2);
    expect(openCalls).toBe(2);
  });
});
