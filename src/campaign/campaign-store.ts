import type { ValidatedCampaign } from "../shared/campaign";
import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { createId } from "../shared/ids";
import { ChromeLocalStorageAdapter, type KeyValueStorage } from "../storage/state-store";
import type { CampaignPolicyConfig, CampaignRepository, CampaignState, DailyLimitState } from "./campaign-types";

export const ACTIVE_CAMPAIGN_KEY = "activeCampaign";

function isCampaignState(value: unknown): value is CampaignState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CampaignState>;
  return candidate.schemaVersion === 1
    && typeof candidate.campaignId === "string"
    && Array.isArray(candidate.recipients)
    && Array.isArray(candidate.images)
    && typeof candidate.status === "string";
}

export function createCampaignState(
  campaign: ValidatedCampaign,
  policy: CampaignPolicyConfig,
  dailyLimit: DailyLimitState,
  now = new Date().toISOString()
): CampaignState {
  return {
    schemaVersion: 1,
    runToken: createId("campaign-run"),
    campaignId: campaign.campaignId,
    campaignName: campaign.campaignName,
    createdBy: campaign.createdBy,
    status: "received",
    recipients: campaign.recipients.map((recipient, index) => ({
      recipientId: recipient.recipientId,
      clientId: recipient.clientId,
      name: recipient.name,
      phoneDigits: recipient.phoneDigits,
      maskedPhone: recipient.maskedPhone,
      source: recipient.source,
      position: index + 1,
      status: "pending"
    })),
    text: campaign.message,
    images: campaign.images.map((image) => ({
      imageId: `image-${image.order}`,
      order: image.order,
      name: image.name,
      type: image.type,
      size: image.size
    })),
    currentRecipientIndex: null,
    activeContactId: null,
    lastCompletedContactId: null,
    completedRecipients: 0,
    batchNumber: 1,
    contactsCompletedInBatch: 0,
    pauseRequested: false,
    stopRequested: false,
    wait: null,
    blockReason: null,
    policy,
    dailyLimit,
    sequence: 1,
    receivedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

export class CampaignStore implements CampaignRepository {
  constructor(private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter()) {}

  async loadActive(): Promise<CampaignState | null> {
    const result = await this.storage.get(ACTIVE_CAMPAIGN_KEY);
    const campaign = result[ACTIVE_CAMPAIGN_KEY];
    if (campaign === null || campaign === undefined) return null;
    if (!isCampaignState(campaign)) {
      throw new ExtensionError(ERROR_CODES.storageError, "La campaña persistida no tiene un formato válido.", { recoverable: false });
    }
    if (!campaign.runToken) {
      const migrated = { ...campaign, runToken: createId("campaign-run"), updatedAt: new Date().toISOString() };
      await this.storage.set({ [ACTIVE_CAMPAIGN_KEY]: migrated });
      return migrated;
    }
    return campaign;
  }

  async saveActive(campaign: CampaignState): Promise<CampaignState> {
    if (!isCampaignState(campaign)) {
      throw new ExtensionError(ERROR_CODES.storageError, "No se puede guardar una campaña inválida.", { recoverable: false });
    }
    await this.storage.set({ [ACTIVE_CAMPAIGN_KEY]: campaign });
    return campaign;
  }

  async clearActive(): Promise<void> {
    await this.storage.set({ [ACTIVE_CAMPAIGN_KEY]: null });
  }
}
