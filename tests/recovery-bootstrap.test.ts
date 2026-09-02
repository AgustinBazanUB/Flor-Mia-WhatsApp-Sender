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

  it("keeps WhatsApp and Web App access narrow and authorizes previews only as exact build-time origins", async () => {
    const manifest = JSON.parse(await read("manifest.json")) as {
      permissions: string[];
      host_permissions: string[];
      content_scripts: Array<{ matches?: string[]; include_globs?: string[]; js?: string[] }>;
    };
    expect(manifest.permissions).toContain("scripting");
    expect(manifest.host_permissions).toContain("https://web.whatsapp.com/*");
    expect(manifest.host_permissions).toContain("https://appintegralflormia.netlify.app/*");
    expect(manifest.host_permissions).not.toContain("https://*.netlify.app/*");
    const bridge = manifest.content_scripts.find((item) => item.js?.includes("content/web-app-bridge.js"));
    expect(bridge?.matches).toContain("https://appintegralflormia.netlify.app/*");
    expect(bridge?.matches).not.toContain("https://*.netlify.app/*");
    expect(bridge?.include_globs).toBeUndefined();
    const build = await read("scripts/build.mjs");
    expect(build).toContain("FLORMIA_EXTRA_WEB_APP_ORIGINS");
    expect(build).toContain("deploy-preview-");
    expect(build).toContain("allowedExtraPreviewPattern");
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
