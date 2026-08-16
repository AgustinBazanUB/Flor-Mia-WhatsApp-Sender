import type { CampaignEngine } from "./campaign-engine";
import type { CampaignState } from "./campaign-types";

export const CAMPAIGN_ALARM_PREFIX = "flor-mia-campaign:";

export interface CampaignWakeupScheduler {
  schedule(campaignId: string, when: number): Promise<void>;
  cancel(campaignId: string): Promise<void>;
}

export class ChromeCampaignWakeupScheduler implements CampaignWakeupScheduler {
  async schedule(campaignId: string, when: number): Promise<void> {
    await chrome.alarms.create(`${CAMPAIGN_ALARM_PREFIX}${campaignId}`, { when: Math.max(Date.now() + 50, when) });
  }

  async cancel(campaignId: string): Promise<void> {
    await chrome.alarms.clear(`${CAMPAIGN_ALARM_PREFIX}${campaignId}`);
  }
}

export interface CampaignSchedulerDependencies {
  engine: CampaignEngine;
  wakeups: CampaignWakeupScheduler;
  onSettled?: (campaign: CampaignState) => Promise<void> | void;
  now?: () => number;
}

export class CampaignScheduler {
  private inFlight: Promise<CampaignState> | null = null;
  private readonly now: () => number;

  constructor(private readonly dependencies: CampaignSchedulerDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
  }

  async schedule(campaign: CampaignState, immediate = false): Promise<void> {
    if (["completed", "stopped", "paused", "images_required", "error", "daily_limit_reached"].includes(campaign.status)) {
      await this.dependencies.wakeups.cancel(campaign.campaignId);
      return;
    }
    const when = immediate
      ? this.now() + 50
      : campaign.wait
        ? Date.parse(campaign.wait.until)
        : this.now() + 50;
    await this.dependencies.wakeups.schedule(campaign.campaignId, when);
  }

  run(campaignId: string): Promise<CampaignState> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.dependencies.engine.advance(campaignId)
      .then(async (campaign) => {
        await this.schedule(campaign);
        await this.dependencies.onSettled?.(campaign);
        return campaign;
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async cancel(campaignId: string): Promise<void> {
    await this.dependencies.wakeups.cancel(campaignId);
  }
}

export function campaignIdFromAlarm(name: string): string | null {
  return name.startsWith(CAMPAIGN_ALARM_PREFIX) ? name.slice(CAMPAIGN_ALARM_PREFIX.length) || null : null;
}
