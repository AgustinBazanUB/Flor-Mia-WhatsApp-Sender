import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("content script recovery bootstrap", () => {
  it("builds the service worker from the recovery bootstrap", async () => {
    const build = await read("scripts/build.mjs");
    expect(build).toContain('src/background/recovery-bootstrap.ts');
    expect(build).toContain('manifest.host_permissions');
  });

  it("has scripting permission and host access for WhatsApp plus Deploy Preview 7", async () => {
    const manifest = JSON.parse(await read("manifest.json")) as {
      permissions: string[];
      host_permissions: string[];
    };
    expect(manifest.permissions).toContain("scripting");
    expect(manifest.host_permissions).toContain("https://web.whatsapp.com/*");
    expect(manifest.host_permissions).toContain("https://deploy-preview-7--appintegralflormia.netlify.app/*");
  });

  it("recovers stale scripts once per loaded extension session", async () => {
    const source = await read("src/background/recovery-bootstrap.ts");
    expect(source).toContain("content/whatsapp.js");
    expect(source).toContain("content/web-app-bridge.js");
    expect(source).toContain("RECOVERY_SESSION_KEY");
    expect(source).toContain("chrome.storage.session");
    expect(source).toContain("lightweightHealth");
    expect(source).toContain("ensureWhatsAppContentScript");
  });
});
