import type { ContactExportState } from "./types";

const KEY = "contactExportStateV1";

export function emptyContactExportState(now = new Date()): ContactExportState {
  return {
    schemaVersion: 1,
    status: "idle",
    operationId: null,
    labels: [],
    selectedLabelIds: [],
    contacts: [],
    problems: [],
    summary: {
      found: 0,
      valid: 0,
      duplicatesRemoved: 0,
      withoutPhone: 0,
      withoutName: 0,
      excludedNonContacts: 0
    },
    progress: null,
    metrics: null,
    labelResults: [],
    diagnostic: {
      status: "unknown",
      lastSuccessfulStep: null,
      failedStep: null,
      labelName: null,
      strategy: null,
      expectedElement: null,
      candidateCount: 0,
      processedCount: 0,
      reportedCount: null,
      collectedUniqueContacts: null,
      lastContactCorrelationId: null,
      errorCode: null,
      errorMessage: null,
      stack: null,
      updatedAt: now.toISOString()
    },
    updatedAt: now.toISOString()
  };
}

export class ContactExportStore {
  async load(): Promise<ContactExportState> {
    const result = await chrome.storage.session.get(KEY);
    const value = result[KEY] as ContactExportState | undefined;
    if (value?.schemaVersion !== 1) return emptyContactExportState();
    return {
      ...emptyContactExportState(),
      ...value,
      metrics: value.metrics ?? null,
      labelResults: value.labelResults ?? [],
      diagnostic: {
        ...emptyContactExportState().diagnostic,
        ...value.diagnostic
      }
    };
  }

  async save(state: ContactExportState): Promise<ContactExportState> {
    const next = { ...state, updatedAt: new Date().toISOString() };
    await chrome.storage.session.set({ [KEY]: next });
    return next;
  }

  async patch(patch: Partial<ContactExportState>): Promise<ContactExportState> {
    const current = await this.load();
    return this.save({ ...current, ...patch });
  }

  async reset(): Promise<ContactExportState> {
    const state = emptyContactExportState();
    await chrome.storage.session.set({ [KEY]: state });
    return state;
  }
}
