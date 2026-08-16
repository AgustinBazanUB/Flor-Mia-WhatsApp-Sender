import type { ContactProcessCheckpoint } from "../engine/types";
import type { CampaignPublicStatus, CampaignState } from "./campaign-types";
import { progressForCampaign } from "./progress";

export function toCampaignPublicStatus(
  campaign: CampaignState,
  checkpoint: ContactProcessCheckpoint | null
): CampaignPublicStatus {
  const recipient = campaign.activeContactId
    ? campaign.recipients.find((item) => item.recipientId === campaign.activeContactId) ?? null
    : campaign.currentRecipientIndex === null
      ? null
      : campaign.recipients[campaign.currentRecipientIndex] ?? null;
  return {
    campaignId: campaign.campaignId,
    campaignName: campaign.campaignName,
    status: campaign.status,
    progress: progressForCampaign(campaign),
    currentContact: recipient ? {
      position: recipient.position,
      total: campaign.recipients.length,
      name: recipient.name,
      maskedPhone: recipient.maskedPhone
    } : null,
    currentStepId: checkpoint?.campaignId === campaign.campaignId ? checkpoint.currentStepId : null,
    lastConfirmedStepId: checkpoint?.campaignId === campaign.campaignId ? checkpoint.lastConfirmedStepId : null,
    wait: campaign.wait,
    dailyLimit: campaign.dailyLimit,
    blockReason: campaign.blockReason,
    pauseRequested: campaign.pauseRequested,
    stopRequested: campaign.stopRequested,
    sequence: campaign.sequence
  };
}
