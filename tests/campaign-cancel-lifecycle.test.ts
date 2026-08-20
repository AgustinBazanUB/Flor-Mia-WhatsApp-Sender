import { describe, expect, it } from "vitest";
import { CampaignEngine } from "../src/campaign/campaign-engine";
import { createCampaignState } from "../src/campaign/campaign-store";
import { DEFAULT_CAMPAIGN_POLICY } from "../src/campaign/campaign-policy";
import { refreshDailyLimit } from "../src/campaign/daily-limit";
import { validateCampaignInput } from "../src/shared/campaign";
import type { CampaignRepository, DailyLimitRepository, CampaignState } from "../src/campaign/campaign-types";
import type { ContactCheckpointRepository, ContactProcessCheckpoint } from "../src/engine/types";

class Campaigns implements CampaignRepository {
  constructor(public active: CampaignState | null) {}
  async loadActive() { return this.active; }
  async saveActive(value: CampaignState) { this.active = value; return value; }
  async clearActive() { this.active = null; }
}
class Checkpoints implements ContactCheckpointRepository {
  active: ContactProcessCheckpoint | null = null;
  async loadActive(){ return this.active; }
  async saveActive(v: ContactProcessCheckpoint){ this.active=v; return v; }
  async clearActive(){ this.active=null; }
}
function setup(status: CampaignState["status"], activeContactId: string | null = null) {
  const campaign = validateCampaignInput({
    campaignId: "cancel-test", campaignName: "Cancel", createdBy: "tests",
    recipients: [{ recipientId:"r1", name:"", phone:"5491111111111", source:"flor_mia" }],
    message:"Hola", images:[], imageOrder:[], imageCount:0, totalRecipients:1
  });
  const state = createCampaignState(campaign, DEFAULT_CAMPAIGN_POLICY, refreshDailyLimit(null,1000));
  state.status=status; state.activeContactId=activeContactId; state.currentRecipientIndex=activeContactId?0:null;
  const campaigns = new Campaigns(state);
  const checkpoints = new Checkpoints();
  const daily: DailyLimitRepository = {
    async load(){ return state.dailyLimit; },
    async recordCompletion(){ return state.dailyLimit; }
  };
  const engine = new CampaignEngine({
    campaigns, contactCheckpoints: checkpoints, dailyLimit: daily,
    contactRunner: { async run(cp){ return cp; } }
  });
  return { engine, campaigns, checkpoints };
}
describe("campaign cancel lifecycle",()=>{
  it("paused cancel reaches cancelled immediately", async()=>{
    const t=setup("paused","r1");
    const result=await t.engine.requestCancel("cancel-test");
    expect(result.status).toBe("cancelled");
    expect(result.activeContactId).toBeNull();
    expect(result.cancelRequested).toBe(true);
  });
  it("paused stop reaches stopped immediately and never requires a second stop", async()=>{
    const t=setup("paused","r1");
    const first=await t.engine.requestStop("cancel-test");
    expect(first.status).toBe("stopped");
    const second=await t.engine.requestStop("cancel-test");
    expect(second.status).toBe("stopped");
  });
});
