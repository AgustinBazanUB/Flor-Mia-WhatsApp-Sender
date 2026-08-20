import { WEB_APP_ORIGINS } from "../config/origins";
import { assertTransition } from "../shared/state-machine";
import type { ExtensionState, ExtensionStatus, OperationRecord } from "../shared/state";
import { DEFAULT_RETRY_POLICY } from "../engine/retry-policy";
import { DEFAULT_CAMPAIGN_POLICY, normalizeCampaignPolicy } from "../campaign/campaign-policy";
import { createDefaultCompatibilityState } from "../compatibility/fingerprint";
import { normalizeCompatibilityState } from "../compatibility/state-normalizer";
import { recordStorageRead, recordStorageWrite } from "../performance/runtime-metrics";

const STATE_KEY = "extensionState";
const MAX_ERRORS = 20;
const MAX_OPERATIONS = 20;

export interface KeyValueStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class ChromeLocalStorageAdapter implements KeyValueStorage {
  async get(key: string): Promise<Record<string, unknown>> {
    const result = await chrome.storage.local.get(key);
    recordStorageRead(false);
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    recordStorageWrite(items, false);
    await chrome.storage.local.set(items);
  }
}

export function createDefaultState(now = new Date().toISOString()): ExtensionState {
  const date = new Date(now);
  const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return {
    schemaVersion: 7,
    extensionVersion: "unknown",
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
    diagnosticIncident: null,
    serviceWorkerRecovery: null,
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
    const storedState = stored as Partial<ExtensionState> & { activeCampaign?: unknown };
    const activeCampaign = storedState.activeCampaign
      && typeof storedState.activeCampaign === "object"
      && (storedState.activeCampaign as { snapshotSchemaVersion?: unknown }).snapshotSchemaVersion === 1
      ? storedState.activeCampaign as ExtensionState["activeCampaign"]
      : null;
    const compatibility = normalizeCompatibilityState(storedState.compatibility, defaults.updatedAt);
    return {
      ...defaults,
      ...storedState,
      schemaVersion: defaults.schemaVersion,
      activeCampaign,
      config: {
        ...defaults.config,
        ...storedState.config,
        retryPolicy: {
          ...defaults.config.retryPolicy,
          ...storedState.config?.retryPolicy,
          backoff: {
            ...defaults.config.retryPolicy.backoff,
            ...storedState.config?.retryPolicy?.backoff
          },
          timeouts: {
            ...defaults.config.retryPolicy.timeouts,
            ...storedState.config?.retryPolicy?.timeouts
          }
        },
        campaignPolicy: normalizeCampaignPolicy(storedState.config?.campaignPolicy)
      },
      progress: { ...defaults.progress, ...storedState.progress },
      dailyLimit: { ...defaults.dailyLimit, ...storedState.dailyLimit },
      compatibility
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
