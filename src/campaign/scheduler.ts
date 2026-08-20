import type { CampaignEngine } from "./campaign-engine";
import type { CampaignState } from "./campaign-types";

export const CAMPAIGN_ALARM_PREFIX = "flor-mia-campaign:";

export interface CampaignWakeupScheduler {
  schedule(campaignId: string, runToken: string, when: number): Promise<void>;
  cancel(campaignId: string, runToken: string): Promise<void>;
}

export class ChromeCampaignWakeupScheduler implements CampaignWakeupScheduler {
  async schedule(campaignId: string, runToken: string, when: number): Promise<void> {
    await chrome.alarms.create(campaignAlarmName(campaignId, runToken), { when: Math.max(Date.now() + 50, when) });
  }

  async cancel(campaignId: string, runToken: string): Promise<void> {
    await chrome.alarms.clear(campaignAlarmName(campaignId, runToken));
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
    if (!campaign.runToken) throw new Error("La campaña no tiene token de ejecución persistente.");
    if (["completed", "stopped", "cancelled", "paused", "images_required", "error", "daily_limit_reached"].includes(campaign.status)) {
      await this.dependencies.wakeups.cancel(campaign.campaignId, campaign.runToken);
      return;
    }
    const when = immediate
      ? this.now() + 50
      : campaign.wait
        ? Date.parse(campaign.wait.until)
        : this.now() + 50;
    await this.dependencies.wakeups.schedule(campaign.campaignId, campaign.runToken, when);
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

  async cancel(campaign: CampaignState): Promise<void> {
    if (!campaign.runToken) return;
    await this.dependencies.wakeups.cancel(campaign.campaignId, campaign.runToken);
  }
}

export interface CampaignAlarmIdentity {
  campaignId: string;
  runToken: string;
}

export function campaignAlarmName(campaignId: string, runToken: string): string {
  return `${CAMPAIGN_ALARM_PREFIX}${encodeURIComponent(campaignId)}:${encodeURIComponent(runToken)}`;
}

export function campaignAlarmFromName(name: string): CampaignAlarmIdentity | null {
  if (!name.startsWith(CAMPAIGN_ALARM_PREFIX)) return null;
  const encoded = name.slice(CAMPAIGN_ALARM_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator === encoded.length - 1) return null;
  try {
    return {
      campaignId: decodeURIComponent(encoded.slice(0, separator)),
      runToken: decodeURIComponent(encoded.slice(separator + 1))
    };
  } catch {
    return null;
  }
}
