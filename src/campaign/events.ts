import { ChromeLocalStorageAdapter, type KeyValueStorage } from "../storage/state-store";
import type { CampaignPublicStatus } from "./campaign-types";

export const CAMPAIGN_EVENT_KEY = "campaignPublicEvent";

export interface CampaignPublicEvent {
  campaignId: string;
  sequence: number;
  emittedAt: string;
  status: CampaignPublicStatus;
}

export class CampaignEventPublisher {
  constructor(private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter()) {}

  async publish(status: CampaignPublicStatus): Promise<CampaignPublicEvent> {
    const event: CampaignPublicEvent = {
      campaignId: status.campaignId,
      sequence: status.sequence,
      emittedAt: new Date().toISOString(),
      status
    };
    await this.storage.set({ [CAMPAIGN_EVENT_KEY]: event });
    return event;
  }
}
