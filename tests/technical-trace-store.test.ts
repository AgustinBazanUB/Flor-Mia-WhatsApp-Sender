import { describe, expect, it } from "vitest";
import {
  MAX_TRACE_RECORDS_GLOBAL,
  MAX_TRACE_RECORDS_PER_CAMPAIGN,
  TechnicalTraceStore
} from "../src/storage/technical-trace-store";
import type { KeyValueStorage } from "../src/storage/state-store";
import type { TechnicalTraceInput } from "../src/diagnostics/types";

class MemoryStorage implements KeyValueStorage {
  value: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> { return this.value; }
  async set(items: Record<string, unknown>): Promise<void> { this.value = { ...this.value, ...items }; }
}

function trace(campaignId: string, index: number): TechnicalTraceInput {
  const timestamp = new Date(Date.UTC(2026, 7, 15, 12, 0, 0, index)).toISOString();
  return {
    traceId: `${campaignId}-${index}`,
    timestampStart: timestamp,
    timestampEnd: timestamp,
    campaignId,
    contactId: `recipient-${index}`,
    stepId: "image-1",
    attempt: 1,
    action: "process_image_step",
    outcome: "confirmed",
    errorCode: null,
    errorCategory: null,
    verificationMethod: "outgoing-media-dom",
    capability: "outgoing_media_evidence",
    strategy: "media.primary",
    durationMs: 0
  };
}

describe("TechnicalTraceStore", () => {
  it("uses a bounded per-campaign ring buffer and keeps the newest records", async () => {
    const store = new TechnicalTraceStore(new MemoryStorage());
    await store.appendMany(Array.from({ length: 520 }, (_, index) => trace("campaign-a", index)));

    const records = await store.listCampaign("campaign-a", 1_000);
    expect(records).toHaveLength(MAX_TRACE_RECORDS_PER_CAMPAIGN);
    expect(records[0]?.traceId).toBe(`campaign-a-${520 - MAX_TRACE_RECORDS_PER_CAMPAIGN}`);
    expect(records.at(-1)?.traceId).toBe("campaign-a-519");
  });

  it("enforces the global limit, deduplicates trace ids and supports campaign cleanup", async () => {
    const store = new TechnicalTraceStore(new MemoryStorage());
    await store.appendMany(Array.from({ length: 510 }, (_, index) => trace("campaign-a", index)));
    await store.appendMany(Array.from({ length: 510 }, (_, index) => trace("campaign-b", index)));
    await store.appendMany(Array.from({ length: 510 }, (_, index) => trace("campaign-c", index)));
    await store.append({ ...trace("campaign-c", 509), outcome: "reconciled" });

    const all = await store.listRecent(2_000);
    expect(all).toHaveLength(MAX_TRACE_RECORDS_GLOBAL);
    expect(all.filter((record) => record.traceId === "campaign-c-509")).toHaveLength(1);
    expect(all.at(-1)?.outcome).toBe("reconciled");

    await store.clearCampaign("campaign-a");
    expect(await store.listCampaign("campaign-a")).toEqual([]);
    expect((await store.listCampaign("campaign-b")).length).toBeGreaterThan(0);
  });
});
