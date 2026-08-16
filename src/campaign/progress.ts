import type { CampaignProgress, CampaignState } from "./campaign-types";

export function calculateCampaignProgress(completed: number, total: number): CampaignProgress {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeCompleted = Math.min(safeTotal, Math.max(0, Math.floor(completed)));
  return {
    completed: safeCompleted,
    total: safeTotal,
    percentage: safeTotal === 0 ? 0 : Number(((safeCompleted / safeTotal) * 100).toFixed(2))
  };
}

export function progressForCampaign(campaign: CampaignState): CampaignProgress {
  return calculateCampaignProgress(campaign.completedRecipients, campaign.recipients.length);
}
