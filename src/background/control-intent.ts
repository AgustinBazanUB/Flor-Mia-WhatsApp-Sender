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
