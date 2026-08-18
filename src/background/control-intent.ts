import { isAllowedWebAppOrigin } from "../config/origins";
import { INTERNAL_CHANNEL, INTERNAL_MESSAGE_TYPES, PROTOCOL_VERSION } from "../shared/protocol";

export type CampaignControlIntent = "pause" | "stop";

const intents = new Map<string, { kind: CampaignControlIntent; requestedAt: string }>();
const activeControllers = new Map<string, AbortController>();

export function requestCampaignControlIntent(campaignId: string, kind: CampaignControlIntent): string {
  const requestedAt = new Date().toISOString();
  const existing = intents.get(campaignId);
  if (!existing || existing.kind !== "stop") intents.set(campaignId, { kind, requestedAt });
  // AbortController sólo alcanza esperas pre-send que cooperan con AbortSignal.
  // Los clicks/sendAttempted no se abortan: su reconciliación conserva prioridad.
  activeControllers.get(campaignId)?.abort();
  return requestedAt;
}

export function campaignControlIntent(campaignId: string): CampaignControlIntent | null {
  return intents.get(campaignId)?.kind ?? null;
}

export function campaignControlRequestedAt(campaignId: string): string | null {
  return intents.get(campaignId)?.requestedAt ?? null;
}

export function hasCampaignControlIntent(campaignId: string): boolean {
  return intents.has(campaignId);
}

export function clearCampaignControlIntent(campaignId: string): void {
  intents.delete(campaignId);
}

export function registerActiveContactController(campaignId: string, controller: AbortController): void {
  activeControllers.set(campaignId, controller);
  if (intents.has(campaignId)) controller.abort();
}

export function releaseActiveContactController(campaignId: string, controller: AbortController): void {
  if (activeControllers.get(campaignId) === controller) activeControllers.delete(campaignId);
}

function senderMayControl(sender: chrome.runtime.MessageSender, source: unknown): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const url = sender.url ?? "";
  if (source === "popup") return url.startsWith(`chrome-extension://${chrome.runtime.id}/popup/`);
  if (source !== "web-app-bridge") return false;
  try {
    return isAllowedWebAppOrigin(new URL(url).origin);
  } catch {
    return false;
  }
}

// Listener deliberadamente síncrono y mínimo. Se registra durante la evaluación del
// Service Worker, antes del dispatcher serializado. Sólo marca intención/cancela waits
// cooperativos; la transición durable sigue pasando por CampaignEngine y su cola.
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!message || typeof message !== "object") return false;
    const value = message as Record<string, unknown>;
    if (value.channel !== INTERNAL_CHANNEL || value.protocolVersion !== PROTOCOL_VERSION) return false;
    if (!senderMayControl(sender, value.source)) return false;
    const kind = value.type === INTERNAL_MESSAGE_TYPES.campaignPause
      ? "pause"
      : value.type === INTERNAL_MESSAGE_TYPES.campaignStop
        ? "stop"
        : null;
    if (!kind || !value.payload || typeof value.payload !== "object") return false;
    const campaignId = (value.payload as Record<string, unknown>).campaignId;
    if (typeof campaignId !== "string" || !campaignId.trim() || campaignId.length > 200) return false;
    requestCampaignControlIntent(campaignId, kind);
    return false;
  });
}
