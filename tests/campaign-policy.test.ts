import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMPAIGN_POLICY,
  MAX_DELAY_BETWEEN_CONTACTS_MS,
  MIN_DELAY_BETWEEN_CONTACTS_MS,
  normalizeCampaignPolicy
} from "../src/campaign/campaign-policy";

describe("campaign pacing policy", () => {
  it("keeps the default inter-contact delay at 1.5 seconds", () => {
    expect(DEFAULT_CAMPAIGN_POLICY.delayBetweenContactsMs).toBe(1_500);
  });

  it("bounds inter-contact pacing between 500 ms and 2.5 seconds", () => {
    expect(normalizeCampaignPolicy({ delayBetweenContactsMs: 0 }).delayBetweenContactsMs)
      .toBe(MIN_DELAY_BETWEEN_CONTACTS_MS);
    expect(normalizeCampaignPolicy({ delayBetweenContactsMs: 9_000 }).delayBetweenContactsMs)
      .toBe(MAX_DELAY_BETWEEN_CONTACTS_MS);
    expect(normalizeCampaignPolicy({ delayBetweenContactsMs: 1_800 }).delayBetweenContactsMs)
      .toBe(1_800);
  });
});
