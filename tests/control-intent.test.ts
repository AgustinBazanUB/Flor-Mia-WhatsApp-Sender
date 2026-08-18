import { afterEach, describe, expect, it } from "vitest";
import {
  campaignControlIntent,
  clearCampaignControlIntent,
  registerActiveContactController,
  releaseActiveContactController,
  requestCampaignControlIntent
} from "../src/background/control-intent";

const CAMPAIGN_ID = "campaign-control-test";

afterEach(() => clearCampaignControlIntent(CAMPAIGN_ID));

describe("urgent campaign control intent", () => {
  it("aborts an active pre-send wait immediately when pause is requested", () => {
    const controller = new AbortController();
    registerActiveContactController(CAMPAIGN_ID, controller);

    requestCampaignControlIntent(CAMPAIGN_ID, "pause");

    expect(controller.signal.aborted).toBe(true);
    expect(campaignControlIntent(CAMPAIGN_ID)).toBe("pause");
    releaseActiveContactController(CAMPAIGN_ID, controller);
  });

  it("never downgrades a stop intent back to pause", () => {
    requestCampaignControlIntent(CAMPAIGN_ID, "stop");
    requestCampaignControlIntent(CAMPAIGN_ID, "pause");
    expect(campaignControlIntent(CAMPAIGN_ID)).toBe("stop");
  });
});
