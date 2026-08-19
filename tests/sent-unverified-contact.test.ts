import { describe, expect, it } from "vitest";
import { processContact } from "../src/engine/contact-engine";
import { createContactCheckpoint, markInterruptedCheckpointAmbiguous } from "../src/engine/steps";
import type { ContactAdapter, ContactCheckpointRepository, ContactProcessCheckpoint } from "../src/engine/types";

class Store implements ContactCheckpointRepository {
  active: ContactProcessCheckpoint | null = null;
  async loadActive() { return this.active; }
  async saveActive(value: ContactProcessCheckpoint) { this.active = value; return value; }
  async clearActive() { this.active = null; }
}

function noResendAdapter(counters: { sends: number; reconciles: number }): ContactAdapter {
  return {
    async openConversation() {},
    async sendImage() { throw new Error("not used"); },
    async sendText() {
      counters.sends += 1;
      return {
        outcome: "sent_unverified",
        verification: {
          outcome: "sent_unverified",
          confidence: "unverified",
          method: "send-click-unverified",
          observedAt: new Date().toISOString(),
          sendAttempted: true
        }
      };
    },
    async reconcile() {
      counters.reconciles += 1;
      return {
        outcome: "ambiguous",
        verification: { outcome: "ambiguous", method: "unexpected", observedAt: new Date().toISOString(), sendAttempted: true }
      };
    }
  };
}

describe("SENT_UNVERIFIED contact safety", () => {
  it("terminalizes the step and never executes it twice", async () => {
    const store = new Store();
    const counters = { sends: 0, reconciles: 0 };
    const adapter = noResendAdapter(counters);
    const cp = createContactCheckpoint({ campaignId: "c", campaignName: "C", contact: { contactId: "r", phoneDigits: "5491112345678", maskedPhone: "+54*******5678" }, images: [], text: "Hola" });
    const first = await processContact(cp, { store, adapter, sleep: async () => undefined });
    expect(first.status).toBe("completed");
    expect(first.steps[0]).toMatchObject({ status: "confirmed", verification: { outcome: "sent_unverified", sendAttempted: true } });
    const second = await processContact(first, { store, adapter, sleep: async () => undefined });
    expect(second.status).toBe("completed");
    expect(counters.sends).toBe(1);
    expect(counters.reconciles).toBe(0);
  });

  it("Service Worker restart + resume keeps SENT_UNVERIFIED terminal and never sends again", async () => {
    const store = new Store();
    const counters = { sends: 0, reconciles: 0 };
    const adapter = noResendAdapter(counters);
    const cp = createContactCheckpoint({
      campaignId: "restart-campaign",
      campaignName: "Restart",
      contact: { contactId: "restart-contact", phoneDigits: "5491112345678", maskedPhone: "+54*******5678" },
      images: [],
      text: "Hola"
    });
    cp.status = "running";
    cp.currentStepId = "text";
    cp.steps[0] = {
      ...cp.steps[0]!,
      status: "confirmed",
      attempts: 1,
      completedAt: new Date().toISOString(),
      verification: {
        outcome: "sent_unverified",
        confidence: "unverified",
        method: "send-click-unverified",
        observedAt: new Date().toISOString(),
        sendAttempted: true
      }
    };

    const recovered = markInterruptedCheckpointAmbiguous(cp);
    expect(recovered.steps[0]).toMatchObject({ status: "confirmed", verification: { outcome: "sent_unverified", sendAttempted: true } });
    store.active = recovered;

    const resumed = await processContact(recovered, { store, adapter, sleep: async () => undefined });
    expect(resumed.status).toBe("completed");
    expect(resumed.steps[0]).toMatchObject({ status: "confirmed", verification: { outcome: "sent_unverified" } });
    expect(counters.sends).toBe(0);
    expect(counters.reconciles).toBe(0);
  });
});
