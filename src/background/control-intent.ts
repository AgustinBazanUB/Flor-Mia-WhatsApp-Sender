import { isAllowedWebAppOrigin } from "../config/origins";
import { INTERNAL_CHANNEL, INTERNAL_MESSAGE_TYPES, PROTOCOL_VERSION } from "../shared/protocol";

export type CampaignControlIntent = "pause" | "stop" | "cancel";

type CampaignControlRequest = { kind: CampaignControlIntent; requestedAt: string };

const intents = new Map<string, CampaignControlRequest>();
const completedRequests = new Map<string, CampaignControlRequest>();
const activeControllers = new Map<string, AbortController>();

const CONTROL_WEIGHT: Record<CampaignControlIntent, number> = { pause: 1, stop: 2, cancel: 3 };

export function requestCampaignControlIntent(campaignId: string, kind: CampaignControlIntent): string {
  const requestedAt = new Date().toISOString();
  const existing = intents.get(campaignId);
  if (!existing || CONTROL_WEIGHT[kind] >= CONTROL_WEIGHT[existing.kind]) {
    intents.set(campaignId, { kind, requestedAt });
  }
  completedRequests.delete(campaignId);
  activeControllers.get(campaignId)?.abort();
  return requestedAt;
}

export function campaignControlIntent(campaignId: string): CampaignControlIntent | null {
  return intents.get(campaignId)?.kind ?? null;
}

export function campaignControlRequestedAt(campaignId: string): string | null {
  return intents.get(campaignId)?.requestedAt ?? completedRequests.get(campaignId)?.requestedAt ?? null;
}

export function campaignControlKindForTrace(campaignId: string): CampaignControlIntent | null {
  return intents.get(campaignId)?.kind ?? completedRequests.get(campaignId)?.kind ?? null;
}

export function hasCampaignControlIntent(campaignId: string): boolean {
  return intents.has(campaignId);
}

export function clearCampaignControlIntent(campaignId: string): void {
  const current = intents.get(campaignId);
  if (current) completedRequests.set(campaignId, current);
  intents.delete(campaignId);
}

export function registerActiveContactController(campaignId: string, controller: AbortController): void {
  activeControllers.set(campaignId, controller);
  if (intents.has(campaignId)) controller.abort();
}

export function releaseActiveContactController(campaignId: string, controller: AbortController): void {
  if (activeControllers.get(campaignId) === controller) activeControllers.delete(campaignId);
}

export function activeControlControllerCount(): number {
  return activeControllers.size;
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

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!message || typeof message !== "object") return false;
    const value = message as Record<string, unknown>;
    if (value.channel !== INTERNAL_CHANNEL || value.protocolVersion !== PROTOCOL_VERSION) return false;
    if (!senderMayControl(sender, value.source)) return false;
    const kind: CampaignControlIntent | null = value.type === INTERNAL_MESSAGE_TYPES.campaignPause
      ? "pause"
      : value.type === INTERNAL_MESSAGE_TYPES.campaignStop
        ? "stop"
        : value.type === INTERNAL_MESSAGE_TYPES.campaignCancel || value.type === INTERNAL_MESSAGE_TYPES.webAppCancelCampaign
          ? "cancel"
          : null;
    if (!kind || !value.payload || typeof value.payload !== "object") return false;
    const campaignId = (value.payload as Record<string, unknown>).campaignId;
    if (typeof campaignId !== "string" || !campaignId.trim() || campaignId.length > 200) return false;
    requestCampaignControlIntent(campaignId, kind);
    return false;
  });
}
