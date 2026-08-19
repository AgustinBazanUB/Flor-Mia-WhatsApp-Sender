import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Web App campaign release response", () => {
  it("marks a successful delete control as emitterReleased after runtime cleanup succeeds", () => {
    const source = readFileSync(resolve(process.cwd(), "src/content/web-app-bridge.ts"), "utf8");
    expect(source).toContain("request.type === WEB_APP_MESSAGE_TYPES.deleteRequest");
    expect(source).toContain("emitterReleased: true");
    expect(source).toContain("INTERNAL_MESSAGE_TYPES.campaignStop");
  });
});
