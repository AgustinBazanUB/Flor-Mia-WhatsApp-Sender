import { campaignControlKindForTrace, campaignControlRequestedAt } from "../background/control-intent";
import { sanitizeDiagnosticText } from "../diagnostics/sanitizer";
import type { TechnicalTraceInput, TechnicalTraceRecord, TechnicalTraceState } from "../diagnostics/types";
import { ChromeLocalStorageAdapter, type KeyValueStorage } from "./state-store";

export const TECHNICAL_TRACE_STATE_KEY = "technicalTraceState";
export const MAX_TRACE_RECORDS_PER_CAMPAIGN = 500;
export const MAX_TRACE_RECORDS_GLOBAL = 1_000;

function defaultState(now = new Date().toISOString()): TechnicalTraceState {
  return { schemaVersion: 1, records: [], updatedAt: now };
}

function isTraceState(value: unknown): value is TechnicalTraceState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TechnicalTraceState>;
  return candidate.schemaVersion === 1 && Array.isArray(candidate.records);
}

function millisecondsBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
}

function controlTiming(input: TechnicalTraceInput): Partial<TechnicalTraceRecord> {
  const requestedKind = campaignControlKindForTrace(input.campaignId);
  const actionKind = input.action === "campaign_pause" ? "pause" : input.action === "campaign_stop" ? "stop" : null;
  if (!actionKind || requestedKind !== actionKind) return {};
  const requestedAt = campaignControlRequestedAt(input.campaignId);
  if (!requestedAt) return {};
  const completedAt = input.timestampEnd ?? null;
  return {
    requestedAt,
    // El listener urgente captura la orden síncronamente; esa captura es el ACK técnico.
    acknowledgedAt: requestedAt,
    safeBoundaryReachedAt: completedAt,
    completedAt,
    queueWaitMs: millisecondsBetween(requestedAt, input.timestampStart),
    executionMs: input.durationMs === null ? millisecondsBetween(input.timestampStart, completedAt) : Math.max(0, Math.round(input.durationMs)),
    totalMs: millisecondsBetween(requestedAt, completedAt),
    cancelState: completedAt ? "completed" : "requested"
  };
}

function normalize(input: TechnicalTraceInput): TechnicalTraceRecord {
  const timestampEnd = input.timestampEnd ?? null;
  const traceId = input.traceId ?? [
    input.campaignId,
    input.contactId ?? "none",
    input.stepId ?? "none",
    input.attempt ?? "none",
    input.action,
    input.outcome,
    input.timestampStart,
    timestampEnd ?? "open"
  ].join(":");
  return {
    ...input,
    ...controlTiming(input),
    traceId: sanitizeDiagnosticText(traceId, { maxStringLength: 500 }),
    campaignId: sanitizeDiagnosticText(input.campaignId, { maxStringLength: 160 }),
    contactId: input.contactId ? sanitizeDiagnosticText(input.contactId, { maxStringLength: 160 }) : null,
    stepId: input.stepId ? sanitizeDiagnosticText(input.stepId, { maxStringLength: 160 }) : null,
    action: sanitizeDiagnosticText(input.action, { maxStringLength: 160 }),
    outcome: sanitizeDiagnosticText(input.outcome, { maxStringLength: 160 }),
    errorCode: input.errorCode ? sanitizeDiagnosticText(input.errorCode, { maxStringLength: 160 }) : null,
    verificationMethod: input.verificationMethod ? sanitizeDiagnosticText(input.verificationMethod, { maxStringLength: 160 }) : null,
    strategy: input.strategy ? sanitizeDiagnosticText(input.strategy, { maxStringLength: 200 }) : null,
    timestampEnd,
    durationMs: input.durationMs === null ? null : Math.max(0, Math.round(input.durationMs))
  };
}

function bounded(records: TechnicalTraceRecord[]): TechnicalTraceRecord[] {
  const perCampaign = new Map<string, number>();
  const retained: TechnicalTraceRecord[] = [];
  for (const record of [...records].reverse()) {
    const count = perCampaign.get(record.campaignId) ?? 0;
    if (count >= MAX_TRACE_RECORDS_PER_CAMPAIGN) continue;
    perCampaign.set(record.campaignId, count + 1);
    retained.push(record);
    if (retained.length >= MAX_TRACE_RECORDS_GLOBAL) break;
  }
  return retained.reverse();
}

export class TechnicalTraceStore {
  constructor(private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter()) {}

  async load(): Promise<TechnicalTraceState> {
    const result = await this.storage.get(TECHNICAL_TRACE_STATE_KEY);
    const raw = result[TECHNICAL_TRACE_STATE_KEY];
    return isTraceState(raw) ? raw : defaultState();
  }

  async append(input: TechnicalTraceInput): Promise<TechnicalTraceRecord> {
    const record = normalize(input);
    const current = await this.load();
    const records = bounded([...current.records.filter((item) => item.traceId !== record.traceId), record]);
    await this.storage.set({
      [TECHNICAL_TRACE_STATE_KEY]: { schemaVersion: 1, records, updatedAt: new Date().toISOString() } satisfies TechnicalTraceState
    });
    return record;
  }

  async appendMany(inputs: TechnicalTraceInput[]): Promise<TechnicalTraceRecord[]> {
    if (inputs.length === 0) return [];
    const additions = inputs.map(normalize);
    const ids = new Set(additions.map((record) => record.traceId));
    const current = await this.load();
    const records = bounded([...current.records.filter((record) => !ids.has(record.traceId)), ...additions]);
    await this.storage.set({
      [TECHNICAL_TRACE_STATE_KEY]: { schemaVersion: 1, records, updatedAt: new Date().toISOString() } satisfies TechnicalTraceState
    });
    return additions;
  }

  async listCampaign(campaignId: string, limit = MAX_TRACE_RECORDS_PER_CAMPAIGN): Promise<TechnicalTraceRecord[]> {
    const current = await this.load();
    return current.records.filter((record) => record.campaignId === campaignId).slice(-Math.max(0, limit));
  }

  async listRecent(limit = 100): Promise<TechnicalTraceRecord[]> {
    return (await this.load()).records.slice(-Math.max(0, limit));
  }

  async clearCampaign(campaignId: string): Promise<void> {
    const current = await this.load();
    await this.storage.set({
      [TECHNICAL_TRACE_STATE_KEY]: {
        schemaVersion: 1,
        records: current.records.filter((record) => record.campaignId !== campaignId),
        updatedAt: new Date().toISOString()
      } satisfies TechnicalTraceState
    });
  }
}
