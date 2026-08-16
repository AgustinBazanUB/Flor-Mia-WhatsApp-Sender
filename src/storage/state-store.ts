import { WEB_APP_ORIGINS } from "../config/origins";
import { assertTransition } from "../shared/state-machine";
import type { ExtensionState, ExtensionStatus, OperationRecord } from "../shared/state";
import { DEFAULT_RETRY_POLICY } from "../engine/retry-policy";
import { DEFAULT_CAMPAIGN_POLICY, normalizeCampaignPolicy } from "../campaign/campaign-policy";
import { createDefaultCompatibilityState } from "../compatibility/fingerprint";

const STATE_KEY = "extensionState";
const MAX_ERRORS = 20;
const MAX_OPERATIONS = 20;

export interface KeyValueStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class ChromeLocalStorageAdapter implements KeyValueStorage {
  async get(key: string): Promise<Record<string, unknown>> {
    return chrome.storage.local.get(key);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    await chrome.storage.local.set(items);
  }
}

export function createDefaultState(now = new Date().toISOString()): ExtensionState {
  const date = new Date(now);
  const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return {
    schemaVersion: 4,
    status: "idle",
    currentCampaign: null,
    progress: { total: 0, sent: 0, failed: 0 },
    currentContact: null,
    currentStep: null,
    config: {
      webAppOrigins: [...WEB_APP_ORIGINS],
      diagnosticTimeoutMs: 8_000,
      operationTimeoutMs: 30_000,
      retryPolicy: DEFAULT_RETRY_POLICY,
      campaignPolicy: DEFAULT_CAMPAIGN_POLICY
    },
    errors: [],
    lastCheckpoint: null,
    operational: false,
    statusMessage: "Todavía no se ejecutó el diagnóstico.",
    whatsapp: null,
    lastTestResult: null,
    activeContactProcess: null,
    activeCampaign: null,
    dailyLimit: {
      localDate,
      completedToday: 0,
      limit: DEFAULT_CAMPAIGN_POLICY.dailyContactLimit,
      remaining: DEFAULT_CAMPAIGN_POLICY.dailyContactLimit,
      countedContactKeys: [],
      updatedAt: now
    },
    compatibility: createDefaultCompatibilityState(now),
    operations: [],
    updatedAt: now
  };
}

export class StateStore {
  constructor(private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter()) {}

  async load(): Promise<ExtensionState> {
    const result = await this.storage.get(STATE_KEY);
    const stored = result[STATE_KEY];
    if (!stored || typeof stored !== "object") return createDefaultState();
    const defaults = createDefaultState();
    return {
      ...defaults,
      ...stored as Partial<ExtensionState>,
      schemaVersion: defaults.schemaVersion,
      config: {
        ...defaults.config,
        ...(stored as Partial<ExtensionState>).config,
        retryPolicy: {
          ...defaults.config.retryPolicy,
          ...(stored as Partial<ExtensionState>).config?.retryPolicy,
          backoff: {
            ...defaults.config.retryPolicy.backoff,
            ...(stored as Partial<ExtensionState>).config?.retryPolicy?.backoff
          },
          timeouts: {
            ...defaults.config.retryPolicy.timeouts,
            ...(stored as Partial<ExtensionState>).config?.retryPolicy?.timeouts
          }
        },
        campaignPolicy: normalizeCampaignPolicy((stored as Partial<ExtensionState>).config?.campaignPolicy)
      },
      progress: { ...defaults.progress, ...(stored as Partial<ExtensionState>).progress },
      dailyLimit: { ...defaults.dailyLimit, ...(stored as Partial<ExtensionState>).dailyLimit },
      compatibility: {
        ...defaults.compatibility,
        ...(stored as Partial<ExtensionState>).compatibility,
        lastKnownGood: {
          ...defaults.compatibility.lastKnownGood,
          ...(stored as Partial<ExtensionState>).compatibility?.lastKnownGood
        }
      }
    };
  }

  async save(state: ExtensionState): Promise<ExtensionState> {
    const next = { ...state, updatedAt: new Date().toISOString() };
    await this.storage.set({ [STATE_KEY]: next });
    return next;
  }

  async patch(patch: Partial<ExtensionState>): Promise<ExtensionState> {
    return this.save({ ...await this.load(), ...patch });
  }

  async transition(to: ExtensionStatus, patch: Partial<ExtensionState> = {}): Promise<ExtensionState> {
    const current = await this.load();
    assertTransition(current.status, to);
    return this.save({ ...current, ...patch, status: to });
  }

  async appendError(error: ExtensionState["errors"][number]): Promise<ExtensionState> {
    const current = await this.load();
    return this.save({ ...current, errors: [...current.errors, error].slice(-MAX_ERRORS) });
  }

  async appendOperation(operation: OperationRecord): Promise<ExtensionState> {
    const current = await this.load();
    return this.save({ ...current, operations: [...current.operations, operation].slice(-MAX_OPERATIONS) });
  }
}
