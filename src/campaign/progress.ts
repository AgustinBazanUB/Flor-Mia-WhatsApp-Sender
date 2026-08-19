import type { CampaignProgress, CampaignState } from "./campaign-types";

export function calculateCampaignProgress(processed: number, total: number): CampaignProgress {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeProcessed = Math.min(safeTotal, Math.max(0, Math.floor(processed)));
  return {
    completed: safeProcessed,
    total: safeTotal,
    percentage: safeTotal === 0 ? 0 : Number(((safeProcessed / safeTotal) * 100).toFixed(2))
  };
}

export function campaignRecipientCounters(campaign: CampaignState): {
  total: number;
  processed: number;
  sent: number;
  failed: number;
  remaining: number;
} {
  const total = campaign.recipients.length;
  const sent = campaign.recipients.filter((recipient) => recipient.status === "completed").length;
  const failed = campaign.recipients.filter((recipient) => recipient.status === "error").length;
  const processed = Math.min(total, sent + failed);
  return { total, processed, sent, failed, remaining: Math.max(0, total - processed) };
}

export function progressForCampaign(campaign: CampaignState): CampaignProgress {
  const counters = campaignRecipientCounters(campaign);
  return calculateCampaignProgress(counters.processed, counters.total);
}
