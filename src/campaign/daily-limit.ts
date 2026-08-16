import type { DailyLimitRepository, DailyLimitState } from "./campaign-types";
import { ChromeLocalStorageAdapter, type KeyValueStorage } from "../storage/state-store";

export const DAILY_LIMIT_KEY = "campaignDailyLimit";

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function refreshDailyLimit(
  stored: DailyLimitState | null,
  limit: number,
  now = new Date()
): DailyLimitState {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const date = localDateKey(now);
  const completedToday = stored?.localDate === date ? Math.max(0, Math.floor(stored.completedToday)) : 0;
  const countedContactKeys = stored?.localDate === date && Array.isArray(stored.countedContactKeys)
    ? stored.countedContactKeys.filter((item): item is string => typeof item === "string").slice(-normalizedLimit)
    : [];
  return {
    localDate: date,
    completedToday,
    limit: normalizedLimit,
    remaining: Math.max(0, normalizedLimit - completedToday),
    countedContactKeys,
    updatedAt: now.toISOString()
  };
}

export function incrementDailyLimit(state: DailyLimitState, completionKey: string, now = new Date()): DailyLimitState {
  const refreshed = refreshDailyLimit(state, state.limit, now);
  if (refreshed.countedContactKeys.includes(completionKey)) return refreshed;
  const completedToday = refreshed.completedToday + 1;
  return {
    ...refreshed,
    completedToday,
    remaining: Math.max(0, refreshed.limit - completedToday),
    countedContactKeys: [...refreshed.countedContactKeys, completionKey].slice(-refreshed.limit),
    updatedAt: now.toISOString()
  };
}

function isDailyLimitState(value: unknown): value is DailyLimitState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DailyLimitState>;
  return typeof candidate.localDate === "string" && typeof candidate.completedToday === "number";
}

export class DailyLimitStore implements DailyLimitRepository {
  constructor(private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter()) {}

  async load(limit: number, now = new Date()): Promise<DailyLimitState> {
    const result = await this.storage.get(DAILY_LIMIT_KEY);
    const raw = result[DAILY_LIMIT_KEY];
    const next = refreshDailyLimit(isDailyLimitState(raw) ? raw : null, limit, now);
    await this.storage.set({ [DAILY_LIMIT_KEY]: next });
    return next;
  }

  async recordCompletion(limit: number, completionKey: string, now = new Date()): Promise<DailyLimitState> {
    const current = await this.load(limit, now);
    const next = incrementDailyLimit(current, completionKey, now);
    await this.storage.set({ [DAILY_LIMIT_KEY]: next });
    return next;
  }
}
