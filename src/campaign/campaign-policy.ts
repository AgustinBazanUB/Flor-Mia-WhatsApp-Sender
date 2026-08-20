import type { CampaignPolicyConfig } from "./campaign-types";

export const MIN_DELAY_BETWEEN_CONTACTS_MS = 500;
export const MAX_DELAY_BETWEEN_CONTACTS_MS = 2_500;

export const DEFAULT_CAMPAIGN_POLICY: CampaignPolicyConfig = {
  contactsPerBatch: 3,
  delayBetweenContactsMs: 1_500,
  delayBetweenBatchesMs: 15_000,
  dailyContactLimit: 1_000,
  whatsappLoadWaitMs: 30_000
};

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function normalizeCampaignPolicy(
  value: Partial<CampaignPolicyConfig> | undefined,
  fallback: CampaignPolicyConfig = DEFAULT_CAMPAIGN_POLICY
): CampaignPolicyConfig {
  const source = { ...fallback, ...value };
  return {
    contactsPerBatch: Math.max(1, Math.floor(source.contactsPerBatch)),
    delayBetweenContactsMs: clampInteger(
      source.delayBetweenContactsMs,
      MIN_DELAY_BETWEEN_CONTACTS_MS,
      MAX_DELAY_BETWEEN_CONTACTS_MS
    ),
    delayBetweenBatchesMs: Math.max(0, Math.floor(source.delayBetweenBatchesMs)),
    dailyContactLimit: Math.max(1, Math.floor(source.dailyContactLimit)),
    whatsappLoadWaitMs: Math.max(1_000, Math.floor(source.whatsappLoadWaitMs))
  };
}
