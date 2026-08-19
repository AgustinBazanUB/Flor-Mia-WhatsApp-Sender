import "./service-worker";
import { WEB_APP_MATCH_PATTERNS } from "../config/origins";
import { INTERNAL_MESSAGE_TYPES } from "../shared/protocol";
import { CompatibilityManager } from "../compatibility/manager";
import { CompatibilityStore } from "../storage/compatibility-store";
import { StateStore } from "../storage/state-store";
import { WhatsAppTransport } from "./whatsapp-transport";

const RECOVERY_MARKER_KEY = "contentScriptRecoveryMarker";
const RECOVERY_MARKER = "bridge-recovery-2026-08-19-1";
const WHATSAPP_PATTERN = "https://web.whatsapp.com/*";

async function injectIntoTabs(patterns: string[], file: string): Promise<number> {
  if (!chrome.scripting?.executeScript) return 0;
  const tabs = await chrome.tabs.query({ url: patterns });
  let injected = 0;
  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [file],
      });
      injected += 1;
    } catch {
      // La pestaña puede haberse cerrado o estar navegando. El content script
      // declarativo se inyectará normalmente en la siguiente carga.
    }
  }
  return injected;
}

async function refreshLightweightHealth(): Promise<void> {
  const transport = new WhatsAppTransport();
  const tab = await transport.findTab();
  if (!tab?.id) return;
  try {
    const raw = await transport.sendWhenContentReady(
      INTERNAL_MESSAGE_TYPES.whatsappPreflight,
      {
        timeoutMs: 4_000,
        level: "lightweight",
        purpose: "health_check",
        requirements: { needsText: false, needsImages: false },
      },
      tab.id,
      4_000,
    );
    const compatibilityStore = new CompatibilityStore();
    const manager = new CompatibilityManager(
      compatibilityStore,
      chrome.runtime.getManifest().version,
    );
    const evaluated = await manager.evaluate(raw);
    await new StateStore().patch({
      whatsapp: evaluated.preflight,
      compatibility: evaluated.state,
      operational: evaluated.preflight.operational,
      statusMessage: evaluated.preflight.message,
    });
  } catch {
    // No degradamos el estado por una recuperación oportunista. La Web App o el
    // popup pueden ejecutar un preflight completo si WhatsApp todavía está cargando.
  }
}

export async function recoverContentScriptsOnce(): Promise<void> {
  const stored = await chrome.storage.local.get(RECOVERY_MARKER_KEY);
  if (stored[RECOVERY_MARKER_KEY] === RECOVERY_MARKER) return;

  await injectIntoTabs([WHATSAPP_PATTERN], "content/whatsapp.js");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  await refreshLightweightHealth();
  await injectIntoTabs([...WEB_APP_MATCH_PATTERNS], "content/web-app-bridge.js");
  await chrome.storage.local.set({ [RECOVERY_MARKER_KEY]: RECOVERY_MARKER });
}

void recoverContentScriptsOnce().catch(() => undefined);
