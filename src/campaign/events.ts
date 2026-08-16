import { ChromeLocalStorageAdapter, type KeyValueStorage } from "../storage/state-store";
import type { CampaignPublicStatus } from "./campaign-types";

export const CAMPAIGN_EVENT_KEY = "campaignPublicEvent";
export const CAMPAIGN_EVENT_META_KEY = "campaignPublicEventMeta";

export const CAMPAIGN_PUBLIC_EVENT_TYPES = [
  "CAMPAIGN_ACCEPTED",
  "CAMPAIGN_STARTED",
  "CAMPAIGN_PROGRESS",
  "CAMPAIGN_PAUSED",
  "CAMPAIGN_RESUMED",
  "CAMPAIGN_ERROR",
  "CAMPAIGN_STOPPED",
  "CAMPAIGN_COMPLETED"
] as const;

export type CampaignPublicEventType = (typeof CAMPAIGN_PUBLIC_EVENT_TYPES)[number];
const PUBLIC_EVENT_TYPE_SET = new Set<string>(CAMPAIGN_PUBLIC_EVENT_TYPES);

export interface CampaignPublicEvent {
  eventSchemaVersion: 1;
  type: CampaignPublicEventType;
  campaignId: string;
  sequence: number;
  emittedAt: string;
  payload: CampaignPublicStatus;
}

interface CampaignEventMeta {
  schemaVersion: 1;
  campaignId: string;
  lastPublishedSequence: number;
  lastLifecycleType: Exclude<CampaignPublicEventType, "CAMPAIGN_PROGRESS">;
  updatedAt: string;
}

function isEvent(value: unknown): value is CampaignPublicEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CampaignPublicEvent>;
  return candidate.eventSchemaVersion === 1
    && typeof candidate.type === "string"
    && PUBLIC_EVENT_TYPE_SET.has(candidate.type)
    && typeof candidate.campaignId === "string"
    && Number.isInteger(candidate.sequence)
    && Boolean(candidate.payload)
    && candidate.payload?.campaignId === candidate.campaignId
    && candidate.payload.sequence === candidate.sequence;
}

function isMeta(value: unknown): value is CampaignEventMeta {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CampaignEventMeta>;
  return candidate.schemaVersion === 1
    && typeof candidate.campaignId === "string"
    && Number.isInteger(candidate.lastPublishedSequence)
    && typeof candidate.lastLifecycleType === "string";
}

function eventType(status: CampaignPublicStatus, previousLifecycle: CampaignEventMeta["lastLifecycleType"] | null): CampaignPublicEventType {
  if (status.status === "received") return "CAMPAIGN_ACCEPTED";
  if (status.status === "completed") return "CAMPAIGN_COMPLETED";
  if (status.status === "stopped") return "CAMPAIGN_STOPPED";
  if (status.status === "error") return "CAMPAIGN_ERROR";
  if (["paused", "pause_requested", "daily_limit_reached", "images_required"].includes(status.status)) return "CAMPAIGN_PAUSED";
  if (status.status === "running") {
    if (previousLifecycle === "CAMPAIGN_PAUSED") return "CAMPAIGN_RESUMED";
    if (previousLifecycle === "CAMPAIGN_ACCEPTED") return "CAMPAIGN_STARTED";
  }
  return "CAMPAIGN_PROGRESS";
}

function lifecycleType(
  next: CampaignPublicEventType,
  previous: CampaignEventMeta["lastLifecycleType"] | null
): CampaignEventMeta["lastLifecycleType"] {
  if (next !== "CAMPAIGN_PROGRESS") return next;
  return previous ?? "CAMPAIGN_ACCEPTED";
}

export class CampaignEventPublisher {
  constructor(private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter()) {}

  async loadLatest(): Promise<CampaignPublicEvent | null> {
    const value = (await this.storage.get(CAMPAIGN_EVENT_KEY))[CAMPAIGN_EVENT_KEY];
    return isEvent(value) ? value : null;
  }

  async publish(status: CampaignPublicStatus): Promise<CampaignPublicEvent | null> {
    const stored = await this.storage.get(CAMPAIGN_EVENT_META_KEY);
    const rawMeta = stored[CAMPAIGN_EVENT_META_KEY];
    const meta = isMeta(rawMeta) && rawMeta.campaignId === status.campaignId ? rawMeta : null;
    const latest = await this.loadLatest();
    if (latest?.campaignId === status.campaignId && status.sequence <= latest.sequence) return null;
    if (meta && status.sequence <= meta.lastPublishedSequence) return null;

    const type = eventType(status, meta?.lastLifecycleType ?? null);
    const emittedAt = new Date().toISOString();
    const event: CampaignPublicEvent = {
      eventSchemaVersion: 1,
      type,
      campaignId: status.campaignId,
      sequence: status.sequence,
      emittedAt,
      payload: status
    };
    const nextMeta: CampaignEventMeta = {
      schemaVersion: 1,
      campaignId: status.campaignId,
      lastPublishedSequence: status.sequence,
      lastLifecycleType: lifecycleType(type, meta?.lastLifecycleType ?? null),
      updatedAt: emittedAt
    };
    await this.storage.set({ [CAMPAIGN_EVENT_KEY]: event, [CAMPAIGN_EVENT_META_KEY]: nextMeta });
    return event;
  }
}
