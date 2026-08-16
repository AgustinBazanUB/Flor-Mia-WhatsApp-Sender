import { describe, expect, it } from "vitest";
import type { CampaignPublicStatus } from "../src/campaign/campaign-types";
import { INTERNAL_MESSAGE_TYPES } from "../src/shared/protocol";
import type { KeyValueStorage } from "../src/storage/state-store";
import {
  MAX_WEB_APP_COMMAND_RECORDS,
  WEB_APP_COMMAND_LOG_KEY,
  WebAppCommandGate
} from "../src/background/web-app-command-gate";

class MemoryStorage implements KeyValueStorage {
  data: Record<string, unknown> = {};
  async get(key: string): Promise<Record<string, unknown>> { return { [key]: this.data[key] }; }
  async set(items: Record<string, unknown>): Promise<void> { Object.assign(this.data, items); }
}

function status(sequence: number, campaignId = "campaign-1"): CampaignPublicStatus {
  return { campaignId, sequence } as CampaignPublicStatus;
}

describe("WebAppCommandGate", () => {
  it.each([
    INTERNAL_MESSAGE_TYPES.campaignStart,
    INTERNAL_MESSAGE_TYPES.campaignPause,
    INTERNAL_MESSAGE_TYPES.campaignResume,
    INTERNAL_MESSAGE_TYPES.campaignStop
  ])("deduplicates a persisted %s request without executing it twice", async (type) => {
    const storage = new MemoryStorage();
    let current = status(4);
    let calls = 0;
    const command = { requestId: `same-${type}`, type, campaignId: "campaign-1", expectedSequence: 4 };
    const firstGate = new WebAppCommandGate(storage);
    const first = await firstGate.execute(command, async () => current, async () => {
      calls += 1;
      current = status(5);
      return current;
    });
    const afterRestart = new WebAppCommandGate(storage);
    const duplicate = await afterRestart.execute(command, async () => current, async () => {
      calls += 1;
      return status(6);
    });

    expect(first.sequence).toBe(5);
    expect(duplicate.sequence).toBe(5);
    expect(calls).toBe(1);
  });

  it("rejects stale sequence commands before mutation", async () => {
    const gate = new WebAppCommandGate(new MemoryStorage());
    let calls = 0;
    await expect(gate.execute({
      requestId: "stale-1",
      type: INTERNAL_MESSAGE_TYPES.campaignPause,
      campaignId: "campaign-1",
      expectedSequence: 7
    }, async () => status(8), async () => {
      calls += 1;
      return status(9);
    })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(calls).toBe(0);
  });

  it("rejects reuse of one requestId for a different mutation", async () => {
    const storage = new MemoryStorage();
    const gate = new WebAppCommandGate(storage);
    await gate.execute({
      requestId: "collision",
      type: INTERNAL_MESSAGE_TYPES.campaignStart,
      campaignId: "campaign-1"
    }, async () => status(1), async () => status(2));
    await expect(gate.execute({
      requestId: "collision",
      type: INTERNAL_MESSAGE_TYPES.campaignStop,
      campaignId: "campaign-1"
    }, async () => status(2), async () => status(3))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("keeps the persistent request log bounded", async () => {
    const storage = new MemoryStorage();
    const gate = new WebAppCommandGate(storage);
    let current = status(1);
    for (let index = 0; index < MAX_WEB_APP_COMMAND_RECORDS + 12; index += 1) {
      await gate.execute({
        requestId: `request-${index}`,
        type: INTERNAL_MESSAGE_TYPES.campaignPause,
        campaignId: "campaign-1"
      }, async () => current, async () => {
        current = status(current.sequence + 1);
        return current;
      });
    }
    const log = storage.data[WEB_APP_COMMAND_LOG_KEY] as { records: unknown[] };
    expect(log.records).toHaveLength(MAX_WEB_APP_COMMAND_RECORDS);
  });

  it("treats a persisted pending record as completed when current state proves the effect", async () => {
    const storage = new MemoryStorage();
    storage.data[WEB_APP_COMMAND_LOG_KEY] = {
      schemaVersion: 1,
      records: [{
        requestId: "pending-start",
        type: INTERNAL_MESSAGE_TYPES.campaignStart,
        campaignId: "campaign-1",
        resultSequence: -1,
        recordedAt: "2026-08-16T00:00:00.000Z"
      }]
    };
    let calls = 0;
    const result = await new WebAppCommandGate(storage).execute({
      requestId: "pending-start",
      type: INTERNAL_MESSAGE_TYPES.campaignStart,
      campaignId: "campaign-1"
    }, async () => status(5), async () => {
      calls += 1;
      return status(6);
    });
    expect(result.sequence).toBe(5);
    expect(calls).toBe(0);
  });
});
