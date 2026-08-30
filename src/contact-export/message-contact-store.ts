import type { MessageContactWorkflowState } from "./add-contacts-by-message";

const KEY = "messageContactWorkflowStateV1";

export function emptyMessageContactWorkflowState(now = new Date()): MessageContactWorkflowState {
  return {
    schemaVersion: 1,
    status: "idle",
    operationId: null,
    targetLabel: null,
    targetContactCountBefore: null,
    targetContactCountAfter: null,
    search: {
      searchText: "",
      mode: "contains",
      inboundOnly: true,
      excludeGroups: true,
      excludeCommunities: true,
      excludeChannels: true
    },
    items: [],
    summary: {
      messagesFound: 0,
      uniqueContacts: 0,
      alreadyInList: 0,
      newContacts: 0,
      unresolved: 0,
      added: 0,
      failed: 0
    },
    progress: null,
    metrics: null,
    pauseRequested: false,
    cancelRequested: false,
    diagnostic: {
      status: "unknown",
      currentStep: null,
      lastSuccessfulStep: null,
      failedStep: null,
      lastSuccessfulContactId: null,
      errorCode: null,
      errorMessage: null,
      strategy: null,
      updatedAt: now.toISOString()
    },
    updatedAt: now.toISOString()
  };
}

export class MessageContactStore {
  async load(): Promise<MessageContactWorkflowState> {
    const result = await chrome.storage.session.get(KEY);
    const value = result[KEY] as MessageContactWorkflowState | undefined;
    if (value?.schemaVersion !== 1) return emptyMessageContactWorkflowState();
    const empty = emptyMessageContactWorkflowState();
    return {
      ...empty,
      ...value,
      search: { ...empty.search, ...value.search },
      summary: { ...empty.summary, ...value.summary },
      diagnostic: { ...empty.diagnostic, ...value.diagnostic }
    };
  }

  async save(state: MessageContactWorkflowState): Promise<MessageContactWorkflowState> {
    const next = { ...state, updatedAt: new Date().toISOString() };
    await chrome.storage.session.set({ [KEY]: next });
    return next;
  }

  async patch(patch: Partial<MessageContactWorkflowState>): Promise<MessageContactWorkflowState> {
    const current = await this.load();
    return this.save({ ...current, ...patch });
  }

  async reset(): Promise<MessageContactWorkflowState> {
    const state = emptyMessageContactWorkflowState();
    await chrome.storage.session.set({ [KEY]: state });
    return state;
  }
}
