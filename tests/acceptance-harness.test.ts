import { describe, expect, it } from "vitest";
import {
  FakeCampaignAlarms,
  FakeCampaignClock,
  FakeWhatsAppAdapter,
  RestartableCheckpointStore,
  acceptanceCheckpoint,
  runAcceptanceContact
} from "./harness/acceptance-harness";

describe("A–L integration harness without real messages", () => {
  it.each([
    [0, ["open", "text"]],
    [1, ["open", "image-1", "text"]],
    [3, ["open", "image-1", "image-2", "image-3", "text"]]
  ] as const)("covers A–C with %i images in exact atomic order", async (images, calls) => {
    const { result, adapter } = await runAcceptanceContact(images);
    expect(result.status).toBe("completed");
    expect(adapter.calls).toEqual(calls);
  });

  it.each(["offline", "reload", "selector_break"] as const)("simulates %s without touching WhatsApp", async (condition) => {
    const adapter = new FakeWhatsAppAdapter();
    adapter.condition = condition;
    const { result } = await runAcceptanceContact(0, adapter);
    expect(["paused", "failed"]).toContain(result.status);
    expect(result.steps[0]?.status).not.toBe("confirmed");
  });

  it("provides deterministic clock, fake alarms and persistent restartable checkpoints", async () => {
    const clock = new FakeCampaignClock();
    const alarms = new FakeCampaignAlarms();
    await alarms.schedule("campaign-1", clock.now().getTime() + 1_000);
    clock.advance(1_000);
    expect(alarms.scheduled.get("campaign-1")).toBe(clock.now().getTime());

    const store = new RestartableCheckpointStore();
    await store.saveActive(acceptanceCheckpoint(1));
    expect((await store.restart().loadActive())?.campaignId).toBe("acceptance-campaign");
  });
});
