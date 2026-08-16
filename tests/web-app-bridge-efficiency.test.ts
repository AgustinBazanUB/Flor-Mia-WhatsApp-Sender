import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Web-App bridge efficiency", () => {
  it("forwards validated serialized images without decoding and encoding base64 again", async () => {
    const source = await readFile(new URL("../src/content/web-app-bridge.ts", import.meta.url), "utf8");

    expect(source).not.toContain("deserializeCampaign(");
    expect(source).not.toContain("serializeCampaign(");
    expect(source).toContain("request.payload as unknown as SerializedCampaignPayload");
  });

  it("exposes a user-triggered preflight without adding a timer to the content script", async () => {
    const source = await readFile(new URL("../src/content/web-app-bridge.ts", import.meta.url), "utf8");

    expect(source).toContain("WEB_APP_MESSAGE_TYPES.preflightRequest");
    expect(source).not.toContain("setInterval(");
  });
});
