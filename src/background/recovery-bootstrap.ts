import "./service-worker";
import "./contact-export-bootstrap";
import { WEB_APP_MATCH_PATTERNS } from "../config/origins";
import { INTERNAL_MESSAGE_TYPES } from "../shared/protocol";
import type { WhatsAppPreflightResult } from "../shared/state";
import { CompatibilityManager } from "../compatibility/manager";
import { CompatibilityStore } from "../storage/compatibility-store";
import { StateStore } from "../storage/state-store";
import { WhatsAppTransport } from "./whatsapp-transport";

const RECOVERY_SESSION_KEY = "contentScriptRecoveryCompleted";
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

async function lightweightHealth(transport: WhatsAppTransport): Promise<WhatsAppPreflightResult | null> {
  const tab = await transport.findTab();
  if (!tab?.id) return null;
  return transport.sendWhenContentReady(
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
}

async function persistLightweightHealth(raw: WhatsAppPreflightResult): Promise<void> {
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
}

async function ensureWhatsAppContentScript(): Promise<void> {
  const transport = new WhatsAppTransport();
  try {
    const current = await lightweightHealth(transport);
    if (current) await persistLightweightHealth(current);
    return;
  } catch {
    // Un receiving-end ausente después de recargar/actualizar la extensión deja
    // la pestaña abierta pero con un Content Script perteneciente al runtime viejo.
  }

  await injectIntoTabs([WHATSAPP_PATTERN], "content/whatsapp.js");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  try {
    const recovered = await lightweightHealth(transport);
    if (recovered) await persistLightweightHealth(recovered);
  } catch {
    // No convertimos una recuperación oportunista en un error nuevo. El preflight
    // explícito conserva la responsabilidad de diagnosticar WhatsApp si sigue cargando.
  }
}

export async function recoverContentScriptsOnce(): Promise<void> {
  const stored = await chrome.storage.session.get(RECOVERY_SESSION_KEY);
  if (stored[RECOVERY_SESSION_KEY] === true) return;

  await ensureWhatsAppContentScript();
  // El bridge tiene un guard de generación: una inyección nueva retira de forma
  // determinista cualquier bridge viejo y evita listeners duplicados en la Web App.
  await injectIntoTabs([...WEB_APP_MATCH_PATTERNS], "content/web-app-bridge.js");
  await chrome.storage.session.set({ [RECOVERY_SESSION_KEY]: true });
}

void recoverContentScriptsOnce().catch(() => undefined);