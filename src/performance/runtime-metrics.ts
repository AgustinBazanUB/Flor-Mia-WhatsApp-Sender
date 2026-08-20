export interface DurationMetric {
  count: number;
  totalMs: number;
  lastMs: number;
  maxMs: number;
}

export interface RuntimeMetricsSnapshot {
  sessionStartedAt: string;
  storageReads: number;
  storageWrites: number;
  storageBytesWritten: number;
  indexedDbReads: number;
  indexedDbWrites: number;
  indexedDbBytesWritten: number;
  campaignSyncCount: number;
  runtimeMessages: number;
  webAppMessages: number;
  contentMessages: number;
  observerCreated: number;
  observerDisconnected: number;
  activeObservers: number;
  timerCreated: number;
  timerCleared: number;
  activeTimers: number;
  queueDepth: number;
  maxQueueDepth: number;
  commandDurationMs: DurationMetric;
  preflightDurationMs: DurationMetric;
  reportDurationMs: DurationMetric;
}

function durationMetric(): DurationMetric {
  return { count: 0, totalMs: 0, lastMs: 0, maxMs: 0 };
}

const state: RuntimeMetricsSnapshot = {
  sessionStartedAt: new Date().toISOString(),
  storageReads: 0,
  storageWrites: 0,
  storageBytesWritten: 0,
  indexedDbReads: 0,
  indexedDbWrites: 0,
  indexedDbBytesWritten: 0,
  campaignSyncCount: 0,
  runtimeMessages: 0,
  webAppMessages: 0,
  contentMessages: 0,
  observerCreated: 0,
  observerDisconnected: 0,
  activeObservers: 0,
  timerCreated: 0,
  timerCleared: 0,
  activeTimers: 0,
  queueDepth: 0,
  maxQueueDepth: 0,
  commandDurationMs: durationMetric(),
  preflightDurationMs: durationMetric(),
  reportDurationMs: durationMetric()
};

export function estimatedStructuredBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

function addDuration(metric: DurationMetric, durationMs: number): void {
  const value = Math.max(0, Math.round(durationMs));
  metric.count += 1;
  metric.totalMs += value;
  metric.lastMs = value;
  metric.maxMs = Math.max(metric.maxMs, value);
}

export function recordStorageRead(indexedDb = false): void {
  if (indexedDb) state.indexedDbReads += 1;
  else state.storageReads += 1;
}

export function recordStorageWrite(value: unknown, indexedDb = false): number {
  const bytes = estimatedStructuredBytes(value);
  if (indexedDb) {
    state.indexedDbWrites += 1;
    state.indexedDbBytesWritten += bytes;
  } else {
    state.storageWrites += 1;
    state.storageBytesWritten += bytes;
  }
  return bytes;
}

export function recordCampaignSync(): void {
  state.campaignSyncCount += 1;
}

export function recordRuntimeMessage(source?: string): void {
  state.runtimeMessages += 1;
  if (source === "web-app-bridge") state.webAppMessages += 1;
  if (source === "whatsapp-content") state.contentMessages += 1;
}

export function recordObserverCreated(): void {
  state.observerCreated += 1;
  state.activeObservers += 1;
}

export function recordObserverDisconnected(): void {
  state.observerDisconnected += 1;
  state.activeObservers = Math.max(0, state.activeObservers - 1);
}

export function recordTimerCreated(): void {
  state.timerCreated += 1;
  state.activeTimers += 1;
}

export function recordTimerCleared(): void {
  state.timerCleared += 1;
  state.activeTimers = Math.max(0, state.activeTimers - 1);
}

export function recordQueueDepth(depth: number): void {
  state.queueDepth = Math.max(0, Math.floor(depth));
  state.maxQueueDepth = Math.max(state.maxQueueDepth, state.queueDepth);
}

export function recordCommandDuration(durationMs: number): void {
  addDuration(state.commandDurationMs, durationMs);
}

export function recordPreflightDuration(durationMs: number): void {
  addDuration(state.preflightDurationMs, durationMs);
}

export function recordReportDuration(durationMs: number): void {
  addDuration(state.reportDurationMs, durationMs);
}

export function snapshotRuntimeMetrics(): RuntimeMetricsSnapshot {
  return structuredClone(state);
}

export function resetRuntimeMetricsForTests(): void {
  const fresh: RuntimeMetricsSnapshot = {
    ...state,
    sessionStartedAt: new Date().toISOString(),
    storageReads: 0,
    storageWrites: 0,
    storageBytesWritten: 0,
    indexedDbReads: 0,
    indexedDbWrites: 0,
    indexedDbBytesWritten: 0,
    campaignSyncCount: 0,
    runtimeMessages: 0,
    webAppMessages: 0,
    contentMessages: 0,
    observerCreated: 0,
    observerDisconnected: 0,
    activeObservers: 0,
    timerCreated: 0,
    timerCleared: 0,
    activeTimers: 0,
    queueDepth: 0,
    maxQueueDepth: 0,
    commandDurationMs: durationMetric(),
    preflightDurationMs: durationMetric(),
    reportDurationMs: durationMetric()
  };
  Object.assign(state, fresh);
}
