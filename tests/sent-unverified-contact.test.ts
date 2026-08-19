import { describe, expect, it } from "vitest";
import { processContact } from "../src/engine/contact-engine";
import { createContactCheckpoint } from "../src/engine/steps";
import type { ContactAdapter, ContactCheckpointRepository, ContactProcessCheckpoint } from "../src/engine/types";

class Store implements ContactCheckpointRepository {
  active: ContactProcessCheckpoint | null = null;
  async loadActive() { return this.active; }
  async saveActive(value: ContactProcessCheckpoint) { this.active = value; return value; }
  async clearActive() { this.active = null; }
}

describe("SENT_UNVERIFIED contact safety", () => {
  it("terminalizes the step and never executes it twice", async () => {
    const store = new Store();
    let sends = 0; let reconciles = 0;
    const adapter: ContactAdapter = {
      async openConversation() {},
      async sendImage() { throw new Error("not used"); },
      async sendText() { sends += 1; return { outcome: "sent_unverified", verification: { outcome: "sent_unverified", confidence: "unverified", method: "send-click-unverified", observedAt: new Date().toISOString(), sendAttempted: true } }; },
      async reconcile() { reconciles += 1; return { outcome: "ambiguous", verification: { outcome: "ambiguous", method: "unexpected", observedAt: new Date().toISOString(), sendAttempted: true } }; }
    };
    const cp = createContactCheckpoint({ campaignId: "c", campaignName: "C", contact: { contactId: "r", phoneDigits: "5491112345678", maskedPhone: "+54*******5678" }, images: [], text: "Hola" });
    const first = await processContact(cp, { store, adapter, sleep: async () => undefined });
    expect(first.status).toBe("completed");
    expect(first.steps[0]).toMatchObject({ status: "confirmed", verification: { outcome: "sent_unverified", sendAttempted: true } });
    const second = await processContact(first, { store, adapter, sleep: async () => undefined });
    expect(second.status).toBe("completed");
    expect(sends).toBe(1);
    expect(reconciles).toBe(0);
  });
});
