import { ERROR_CODES, ExtensionError, serializeError, toExtensionError } from "../shared/errors";
import { DEFAULT_RETRY_POLICY, retryDelayMs, type RetryPolicyConfig } from "./retry-policy";
import { StepExecutor } from "./step-executor";
import type {
  ContactAdapter,
  ContactCheckpointRepository,
  ContactPauseReason,
  ContactProcessCheckpoint,
  ContactStep,
  StepExecutionResult,
  StepReconciliationResult,
  StepTechnicalRecord
} from "./types";

const MAX_TECHNICAL_HISTORY = 100;

export interface ContactEngineDependencies {
  store: ContactCheckpointRepository;
  adapter: ContactAdapter;
  policy?: RetryPolicyConfig;
  now?: () => string;
  sleep?: (delayMs: number) => Promise<void>;
  onCheckpoint?: (checkpoint: ContactProcessCheckpoint) => Promise<void> | void;
  shouldPause?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
}

function cloneCheckpoint(checkpoint: ContactProcessCheckpoint): ContactProcessCheckpoint {
  return {
    ...checkpoint,
    contact: { ...checkpoint.contact },
    steps: checkpoint.steps.map((step) => ({
      ...step,
      ...(step.kind === "image" ? { image: { ...step.image } } : {}),
      ...(step.verification ? {
        verification: {
          ...step.verification,
          ...(step.verification.baselineOutgoingIds ? { baselineOutgoingIds: [...step.verification.baselineOutgoingIds] } : {})
        }
      } : {})
    })) as ContactStep[],
    history: checkpoint.history.map((record) => ({ ...record }))
  };
}

function withStep(checkpoint: ContactProcessCheckpoint, stepId: string, update: (step: ContactStep) => ContactStep): ContactProcessCheckpoint {
  return {
    ...checkpoint,
    steps: checkpoint.steps.map((step) => step.id === stepId ? update(step) : step)
  };
}

function technicalRecord(
  checkpoint: ContactProcessCheckpoint,
  step: ContactStep,
  result: StepTechnicalRecord["result"],
  timestamp: string,
  options: { verificationMethod?: string; errorCode?: string } = {}
): StepTechnicalRecord {
  return {
    timestamp,
    campaignId: checkpoint.campaignId,
    contactId: checkpoint.contact.contactId,
    stepId: step.id,
    attempt: step.attempts,
    result,
    ...options
  };
}

function appendHistory(checkpoint: ContactProcessCheckpoint, record: StepTechnicalRecord): ContactProcessCheckpoint {
  return { ...checkpoint, history: [...checkpoint.history, record].slice(-MAX_TECHNICAL_HISTORY) };
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

export async function processContact(
  initial: ContactProcessCheckpoint,
  dependencies: ContactEngineDependencies
): Promise<ContactProcessCheckpoint> {
  const policy = dependencies.policy ?? DEFAULT_RETRY_POLICY;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const sleep = dependencies.sleep ?? defaultSleep;
  const executor = new StepExecutor(dependencies.adapter);

  const existing = await dependencies.store.loadActive();
  if (existing && existing.checkpointId !== initial.checkpointId) {
    throw new ExtensionError(ERROR_CODES.internal, "Ya existe otro contacto activo. Finalizalo o cancelalo antes de continuar.", { recoverable: false });
  }
  let checkpoint = cloneCheckpoint(existing ?? initial);
  const resumedStepId = checkpoint.pauseReason === "max_attempts" ? checkpoint.currentStepId : null;
  const resumedStepAttemptLimit = resumedStepId
    ? (checkpoint.steps.find((step) => step.id === resumedStepId)?.attempts ?? 0) + policy.maxAttemptsPerStep
    : policy.maxAttemptsPerStep;
  // Los intentos de apertura son acumulativos para diagnóstico, pero cada
  // invocación explícita dispone de su propia ventana acotada de reintentos.
  const openConversationAttemptLimit = checkpoint.openConversationAttempts + policy.maxAttemptsPerStep;

  const persist = async (next: ContactProcessCheckpoint): Promise<ContactProcessCheckpoint> => {
    const saved = await dependencies.store.saveActive({ ...cloneCheckpoint(next), updatedAt: now() });
    await dependencies.onCheckpoint?.(saved);
    return saved;
  };

  if (checkpoint.status === "completed") return checkpoint;

  let opened = false;
  while (!opened && checkpoint.openConversationAttempts < openConversationAttemptLimit) {
    checkpoint = await persist({
      ...checkpoint,
      status: "opening_chat",
      pauseReason: undefined,
      openConversationAttempts: checkpoint.openConversationAttempts + 1
    });
    try {
      await dependencies.adapter.openConversation(checkpoint.contact, policy.timeouts.openConversationMs, dependencies.signal);
      opened = true;
      checkpoint = await persist({ ...checkpoint, status: "running", error: undefined });
    } catch (error) {
      const normalized = toExtensionError(error);
      checkpoint = await persist({ ...checkpoint, error: serializeError(normalized) });
      if (!normalized.recoverable || checkpoint.openConversationAttempts >= openConversationAttemptLimit) {
        checkpoint = await persist({
          ...checkpoint,
          status: normalized.recoverable ? "paused" : "failed",
          pauseReason: normalized.recoverable ? "open_conversation_failed" : "non_recoverable_error"
        });
        return checkpoint;
      }
      if (await dependencies.shouldPause?.()) {
        return persist({ ...checkpoint, status: "paused", pauseReason: "manual_pause" });
      }
      await sleep(retryDelayMs(checkpoint.openConversationAttempts, policy));
    }
  }

  for (const originalStep of checkpoint.steps) {
    let step = checkpoint.steps.find((candidate) => candidate.id === originalStep.id)!;
    if (step.status === "confirmed") continue;
    if (await dependencies.shouldPause?.()) {
      return persist({ ...checkpoint, status: "paused", currentStepId: step.id, pauseReason: "manual_pause" });
    }
    checkpoint = await persist({ ...checkpoint, status: "running", currentStepId: step.id, pauseReason: undefined });

    if (step.status === "verification_pending") {
      const reconciled = await executor.reconcile(step, {
        checkpoint,
        timeoutMs: policy.timeouts.reconciliationMs,
        imageLoadTimeoutMs: policy.timeouts.imageLoadMs,
        previewTimeoutMs: policy.timeouts.previewMs,
        signal: dependencies.signal
      });
      checkpoint = await applyReconciliation(checkpoint, step, reconciled, persist, now);
      step = checkpoint.steps.find((candidate) => candidate.id === originalStep.id)!;
      if (step.status === "verification_pending") return checkpoint;
      if (step.status === "confirmed") continue;
    }

    const attemptLimit = step.id === resumedStepId ? resumedStepAttemptLimit : policy.maxAttemptsPerStep;
    while (step.attempts < attemptLimit) {
      const attemptAt = now();
      checkpoint = withStep(checkpoint, step.id, (current) => ({
        ...current,
        status: "in_progress",
        attempts: current.attempts + 1,
        startedAt: current.startedAt ?? attemptAt,
        lastAttemptAt: attemptAt,
        error: undefined
      }));
      step = checkpoint.steps.find((candidate) => candidate.id === originalStep.id)!;
      checkpoint = appendHistory(checkpoint, technicalRecord(checkpoint, step, "started", attemptAt));
      checkpoint = await persist(checkpoint);

      let result: StepExecutionResult;
      try {
        result = await executor.execute(step, {
          checkpoint,
          timeoutMs: step.kind === "image" ? policy.timeouts.confirmationMs : policy.timeouts.composerMs + policy.timeouts.confirmationMs,
          imageLoadTimeoutMs: policy.timeouts.imageLoadMs,
          previewTimeoutMs: policy.timeouts.previewMs,
          signal: dependencies.signal
        });
      } catch (error) {
        const normalized = toExtensionError(error);
        result = {
          outcome: "failed",
          error: serializeError(normalized),
          recoverable: normalized.recoverable,
          sendAttempted: false
        };
      }

      // El Content Script persiste esta marca antes del click. Si la respuesta del
      // tab se pierde después, prevalece el checkpoint duradero y no reintentamos a ciegas.
      if (result.outcome === "failed") {
        const durable = await dependencies.store.loadActive();
        const durableStep = durable?.checkpointId === checkpoint.checkpointId
          ? durable.steps.find((candidate) => candidate.id === step.id)
          : undefined;
        if (durable && durableStep?.status === "in_progress" && durableStep.verification?.sendAttempted === true) {
          checkpoint = cloneCheckpoint(durable);
          step = checkpoint.steps.find((candidate) => candidate.id === originalStep.id)!;
          result = {
            outcome: "ambiguous",
            verification: durableStep.verification,
            error: result.error
          };
        }
      }

      checkpoint = await applyExecutionResult(checkpoint, step, result, attemptLimit, persist, now);
      step = checkpoint.steps.find((candidate) => candidate.id === originalStep.id)!;

      if (step.status === "confirmed") break;
      if (step.status === "verification_pending" || step.status === "images_required" || checkpoint.status === "failed") return checkpoint;
      if (step.status === "failed") return checkpoint;
      if (await dependencies.shouldPause?.()) {
        return persist({ ...checkpoint, status: "paused", pauseReason: "manual_pause" });
      }
      await sleep(retryDelayMs(step.attempts, policy));
    }

    step = checkpoint.steps.find((candidate) => candidate.id === originalStep.id)!;
    if (step.status !== "confirmed") return checkpoint;
  }

  const completedAt = now();
  checkpoint = await persist({
    ...checkpoint,
    status: "completed",
    currentStepId: null,
    pauseReason: undefined,
    completedAt
  });
  return checkpoint;
}

async function applyReconciliation(
  checkpoint: ContactProcessCheckpoint,
  step: ContactStep,
  result: StepReconciliationResult,
  persist: (checkpoint: ContactProcessCheckpoint) => Promise<ContactProcessCheckpoint>,
  now: () => string
): Promise<ContactProcessCheckpoint> {
  const timestamp = now();
  if (result.outcome === "confirmed") {
    let next = withStep(checkpoint, step.id, (current) => ({
      ...current,
      status: "confirmed",
      verification: result.verification,
      completedAt: timestamp,
      error: undefined
    }));
    next = appendHistory(next, technicalRecord(next, next.steps.find((item) => item.id === step.id)!, "confirmed", timestamp, {
      verificationMethod: result.verification.method
    }));
    return persist({ ...next, status: "running", lastConfirmedStepId: step.id });
  }
  if (result.outcome === "not_sent") {
    let next = withStep(checkpoint, step.id, (current) => ({
      ...current,
      status: "pending",
      verification: result.verification
    }));
    next = appendHistory(next, technicalRecord(next, next.steps.find((item) => item.id === step.id)!, "not_sent", timestamp, {
      verificationMethod: result.verification.method
    }));
    return persist({ ...next, status: "running" });
  }
  let next = withStep(checkpoint, step.id, (current) => ({
    ...current,
    status: "verification_pending",
    verification: result.verification
  }));
  next = appendHistory(next, technicalRecord(next, next.steps.find((item) => item.id === step.id)!, "ambiguous", timestamp, {
    verificationMethod: result.verification.method
  }));
  return persist({ ...next, status: "paused", pauseReason: "verification_pending" });
}

async function applyExecutionResult(
  checkpoint: ContactProcessCheckpoint,
  step: ContactStep,
  result: StepExecutionResult,
  maxAttemptsPerStep: number,
  persist: (checkpoint: ContactProcessCheckpoint) => Promise<ContactProcessCheckpoint>,
  now: () => string
): Promise<ContactProcessCheckpoint> {
  const timestamp = now();
  if (result.outcome === "confirmed") {
    let next = withStep(checkpoint, step.id, (current) => ({
      ...current,
      status: "confirmed",
      completedAt: timestamp,
      verification: result.verification,
      error: undefined
    }));
    const confirmed = next.steps.find((item) => item.id === step.id)!;
    next = appendHistory(next, technicalRecord(next, confirmed, "confirmed", timestamp, {
      verificationMethod: result.verification.method
    }));
    return persist({ ...next, status: "running", lastConfirmedStepId: step.id });
  }
  if (result.outcome === "ambiguous") {
    let next = withStep(checkpoint, step.id, (current) => ({
      ...current,
      status: "verification_pending",
      verification: result.verification,
      ...(result.error ? { error: result.error } : {})
    }));
    next = appendHistory(next, technicalRecord(next, next.steps.find((item) => item.id === step.id)!, "ambiguous", timestamp, {
      verificationMethod: result.verification.method,
      ...(result.error ? { errorCode: result.error.code } : {})
    }));
    return persist({ ...next, status: "paused", pauseReason: "verification_pending" });
  }
  if (result.outcome === "missing_resource") {
    let next = withStep(checkpoint, step.id, (current) => ({ ...current, status: "images_required", error: result.error }));
    next = appendHistory(next, technicalRecord(next, next.steps.find((item) => item.id === step.id)!, "missing_resource", timestamp, {
      errorCode: result.error.code
    }));
    return persist({ ...next, status: "images_required", pauseReason: "images_required" });
  }

  const current = checkpoint.steps.find((item) => item.id === step.id)!;
  const exhausted = current.attempts >= maxAttemptsPerStep;
  const pauseReason: ContactPauseReason = result.recoverable ? "max_attempts" : "non_recoverable_error";
  let next = withStep(checkpoint, step.id, (candidate) => ({
    ...candidate,
    status: !result.recoverable || exhausted ? "failed" : "pending",
    error: result.error
  }));
  next = appendHistory(next, technicalRecord(next, next.steps.find((item) => item.id === step.id)!, "failed", timestamp, {
    errorCode: result.error.code
  }));
  return persist({
    ...next,
    status: !result.recoverable ? "failed" : exhausted ? "paused" : "running",
    ...(!result.recoverable || exhausted ? { pauseReason } : {})
  });
}
