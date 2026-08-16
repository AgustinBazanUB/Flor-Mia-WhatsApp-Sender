import { ChromeLocalStorageAdapter, type KeyValueStorage } from "../storage/state-store";
import type { CampaignHistoryRecord, CampaignHistoryRepository } from "./campaign-types";

export const CAMPAIGN_HISTORY_KEY = "campaignHistory";
export const MAX_CAMPAIGN_HISTORY_RECORDS = 50;

interface CampaignHistoryState {
  schemaVersion: 1;
  records: CampaignHistoryRecord[];
  updatedAt: string;
}

function defaultState(now = new Date().toISOString()): CampaignHistoryState {
  return { schemaVersion: 1, records: [], updatedAt: now };
}

function isHistoryState(value: unknown): value is CampaignHistoryState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CampaignHistoryState>;
  return candidate.schemaVersion === 1 && Array.isArray(candidate.records);
}

export class CampaignHistoryStore implements CampaignHistoryRepository {
  constructor(
    private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter(),
    private readonly maxRecords = MAX_CAMPAIGN_HISTORY_RECORDS
  ) {}

  private async loadState(): Promise<CampaignHistoryState> {
    const stored = (await this.storage.get(CAMPAIGN_HISTORY_KEY))[CAMPAIGN_HISTORY_KEY];
    return isHistoryState(stored) ? stored : defaultState();
  }

  async upsert(record: CampaignHistoryRecord): Promise<CampaignHistoryRecord> {
    const current = await this.loadState();
    const records = [...current.records.filter((item) => item.campaignId !== record.campaignId), record]
      .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
      .slice(0, this.maxRecords);
    await this.storage.set({
      [CAMPAIGN_HISTORY_KEY]: { schemaVersion: 1, records, updatedAt: new Date().toISOString() } satisfies CampaignHistoryState
    });
    return record;
  }

  async list(): Promise<CampaignHistoryRecord[]> {
    return [...(await this.loadState()).records];
  }
}
