import type {
  ContactAdapter,
  ContactCheckpointRepository,
  ContactStep,
  ImageContactStep,
  StepExecutionContext,
  StepExecutionResult,
  StepReconciliationResult,
  TextContactStep
} from "../engine/types";
import { ERROR_CODES, ExtensionError, serializeError, toExtensionError } from "../shared/errors";
import { logger } from "../shared/logger";
import { INTERNAL_MESSAGE_TYPES } from "../shared/protocol";
import { arrayBufferToBase64 } from "../shared/serialization";
import type { CampaignBlobStore } from "../storage/blob-store";
import { ContactCheckpointStore } from "../storage/checkpoint-store";
import { TechnicalTraceStore } from "../storage/technical-trace-store";
import { WhatsAppTransport } from "./whatsapp-transport";

const CONVERSATION_PROOF_BUDGET_MS = 4_000;
const FIRST_IMAGE_SETTLE_MS = 1_000;
const FOLLOWUP_IMAGE_SETTLE_MS = 500;
const IMAGE_CONFIRMATION_BUDGET_MS = 8_000;
const POST_MEDIA_TEXT_SETTLE_MS = 1_500;

function imageSettleDelayMs(step: ImageContactStep): number {
  return step.image.order <= 1 ? FIRST_IMAGE_SETTLE_MS : FOLLOWUP_IMAGE_SETTLE_MS;
}

async function waitForUiSettle(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Operación cancelada", "AbortError");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new DOMException("Operación cancelada", "AbortError")));
    const timer = globalThis.setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function imageExecutionError(
  error: unknown,
  step: ImageContactStep,
  settleDelayMs: number,
  confirmationTimeoutMs: number
): StepExecutionResult {
  const normalized = toExtensionError(error);
  return executionError(new ExtensionError(normalized.code, normalized.message, {
    recoverable: normalized.recoverable,
    cause: error,
    details: {
      ...(normalized.details ?? {}),
      imageOrder: step.image.order,
      preSendSettleMs: settleDelayMs,
      imageConfirmationTimeoutMs: confirmationTimeoutMs
    }
  }));
}

function executionError(error: unknown): StepExecutionResult {
  const normalized = toExtensionError(error);
  const sendAttempted = normalized.details?.sendAttempted === true;
  if (sendAttempted) {
    return {
      outcome: "ambiguous",
      error: serializeError(normalized),
      verification: {
        outcome: "ambiguous",
        method: "send-attempted-without-confirmation",
        observedAt: new Date().toISOString(),
        sendAttempted: true,
        ...(Array.isArray(normalized.details?.baselineOutgoingIds)
          ? { baselineOutgoingIds: normalized.details.baselineOutgoingIds.filter((item): item is string => typeof item === "string") }
          : {}),
        details: normalized.details
      }
    };
  }
  return {
    outcome: "failed",
    error: serializeError(normalized),
    recoverable: normalized.recoverable,
    sendAttempted: false
  };
}

function defaultCheckpointStore(): ContactCheckpointRepository | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return new ContactCheckpointStore();
}

function defaultTraceStore(): Pick<TechnicalTraceStore, "append"> | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return new TechnicalTraceStore();
}

function stageError(error: unknown, stage: string, elapsedMs: number): ExtensionError {
  const normalized = toExtensionError(error);
  return new ExtensionError(normalized.code, normalized.message, {
    recoverable: normalized.recoverable,
    cause: error,
    details: {
      ...(normalized.details ?? {}),
      stage,
      elapsedMs: Math.max(0, Math.round(elapsedMs))
    }
  });
}

function createNavigationRequestId(contactId: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `navigation:${contactId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

interface PendingConversationOpen {
  contactId: string;
  phoneDigits: string;
  tabId: number;
  navigationRequestId: string;
  previousContentInstanceId: string;
  requestedNavigationAt: string;
  navigationRequestedMs: number;
  navigationObservedAt?: string;
  tabLoadingAt?: string | null;
  tabCompleteAt?: string | null;
}

export class ChromeWhatsAppContactAdapter implements ContactAdapter {
  private whatsappTabId: number | null = null;
  private pendingConversationOpen: PendingConversationOpen | null = null;

  constructor(
    private readonly blobs: Pick<CampaignBlobStore, "getImage">,
    private readonly transport: WhatsAppTransport = new WhatsAppTransport(),
    private readonly checkpoints: ContactCheckpointRepository | null = defaultCheckpointStore(),
    private readonly traces: Pick<TechnicalTraceStore, "append"> | null = defaultTraceStore()
  ) {}

  private async persistTabBinding(contact: Parameters<ContactAdapter["openConversation"]>[0], tabId: number): Promise<void> {
    contact.whatsappTabId = tabId;
    if (!this.checkpoints) return;
    const active = await this.checkpoints.loadActive();
    if (!active || active.contact.contactId !== contact.contactId || active.contact.phoneDigits !== contact.phoneDigits) return;
    if (active.contact.whatsappTabId === tabId) return;
    await this.checkpoints.saveActive({
      ...active,
      contact: { ...active.contact, whatsappTabId: tabId },
      updatedAt: new Date().toISOString()
    });
  }

  private async recordOpenStage(
    contact: Parameters<ContactAdapter["openConversation"]>[0],
    stage: "navigation" | "content_handshake" | "semantic_ready" | "conversation_proof",
    outcome: "confirmed" | "failed" | "reused",
    startedMs: number,
    errorCode: string | null = null
  ): Promise<void> {
    if (!this.traces || !this.checkpoints) return;
    try {
      const active = await this.checkpoints.loadActive();
      if (!active || active.contact.contactId !== contact.contactId || active.contact.phoneDigits !== contact.phoneDigits) return;
      const endedMs = Date.now();
      await this.traces.append({
        timestampStart: new Date(startedMs).toISOString(),
        timestampEnd: new Date(endedMs).toISOString(),
        campaignId: active.campaignId,
        contactId: active.contact.contactId,
        stepId: "open_conversation",
        attempt: active.openConversationAttempts,
        action: `open_conversation.${stage}`,
        outcome,
        errorCode,
        errorCategory: null,
        verificationMethod: stage === "conversation_proof" && outcome === "confirmed" ? "conversation-context-proof" : null,
        capability: null,
        strategy: null,
        durationMs: Math.max(0, endedMs - startedMs)
      });
    } catch (error) {
      logger.debug("whatsapp.open_conversation_trace_skipped", {
        stage,
        errorCode: toExtensionError(error).code
      });
    }
  }

  async openConversation(
    contact: Parameters<ContactAdapter["openConversation"]>[0],
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new DOMException("Operación cancelada", "AbortError");
    const operationStartedMs = Date.now();
    const deadlineMs = operationStartedMs + timeoutMs;
    const remainingBudget = (stage: "navigation" | "content_handshake" | "semantic_ready" | "conversation_proof"): number => {
      const remaining = deadlineMs - Date.now();
      if (remaining > 0) return remaining;
      throw new ExtensionError(ERROR_CODES.timeout, "WhatsApp agotó el tiempo disponible para abrir la conversación.", {
        details: { stage, deadlineRemainingMs: 0 }
      });
    };
    const persistedTabId = Number.isInteger(contact.whatsappTabId) ? contact.whatsappTabId! : null;
    const boundTabId = this.whatsappTabId ?? persistedTabId;
    const tab = boundTabId === null
      ? await this.transport.requireTab()
      : await this.transport.requireTabId(boundTabId);
    this.whatsappTabId = tab.id;
    await this.persistTabBinding(contact, tab.id);

    let pending = this.pendingConversationOpen;
    if (!pending
      || pending.contactId !== contact.contactId
      || pending.phoneDigits !== contact.phoneDigits
      || pending.tabId !== tab.id) {
      const navigationStartedMs = Date.now();
      const navigationRequestId = createNavigationRequestId(contact.contactId);
      try {
        const navigation = await this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, {
          operationId: `open:${contact.contactId}`,
          phoneDigits: contact.phoneDigits,
          navigationRequestId
        }, tab.id);
        if (navigation.navigationRequestId !== navigationRequestId) {
          throw new ExtensionError(ERROR_CODES.protocolError, "La navegación de WhatsApp respondió con una correlación distinta.", { recoverable: false });
        }
        pending = {
          contactId: contact.contactId,
          phoneDigits: contact.phoneDigits,
          tabId: tab.id,
          navigationRequestId,
          previousContentInstanceId: navigation.contentInstanceId,
          requestedNavigationAt: navigation.requestedNavigationAt,
          navigationRequestedMs: Date.now()
        };
        this.pendingConversationOpen = pending;
        const lifecycle = await this.transport.waitForNavigationLifecycle(
          tab.id,
          Math.min(10_000, remainingBudget("navigation")),
          signal,
          { expectedPhoneDigits: contact.phoneDigits, navigationRequestId }
        );
        pending.navigationObservedAt = lifecycle.observedAt;
        pending.tabLoadingAt = lifecycle.loadingAt;
        pending.tabCompleteAt = lifecycle.completeAt;
        await this.recordOpenStage(contact, "navigation", "confirmed", navigationStartedMs);
        logger.info("whatsapp.open_conversation_stage", {
          operationId: `open:${contact.contactId}`,
          navigationRequestId,
          stage: "navigation_observed",
          tabLoadingAt: lifecycle.loadingAt,
          tabCompleteAt: lifecycle.completeAt,
          tabStatus: lifecycle.finalStatus,
          elapsedMs: Date.now() - operationStartedMs,
          deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
        });
      } catch (error) {
        this.pendingConversationOpen = null;
        const normalized = stageError(error, "navigation", Date.now() - navigationStartedMs);
        await this.recordOpenStage(contact, "navigation", "failed", navigationStartedMs, normalized.code);
        throw normalized;
      }
    } else {
      await this.recordOpenStage(contact, "navigation", "reused", Date.now());
      logger.debug("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        navigationRequestId: pending.navigationRequestId,
        stage: "reuse_pending_navigation",
        elapsedMs: Date.now() - operationStartedMs,
        deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
      });
    }

    const handshakeStartedMs = Date.now();
    let handshake;
    try {
      handshake = await this.transport.waitForContentHandshake(tab.id, remainingBudget("content_handshake"), signal, {
        previousContentInstanceId: pending.previousContentInstanceId,
        purpose: "content_handshake",
        navigationRequestId: pending.navigationRequestId
      });
      await this.recordOpenStage(contact, "content_handshake", "confirmed", handshakeStartedMs);
    } catch (error) {
      const normalized = stageError(error, "content_handshake", Date.now() - handshakeStartedMs);
      if (normalized.code === ERROR_CODES.whatsappNotOpen) this.pendingConversationOpen = null;
      await this.recordOpenStage(contact, "content_handshake", "failed", handshakeStartedMs, normalized.code);
      logger.warn("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        navigationRequestId: pending.navigationRequestId,
        stage: "content_handshake_failed",
        errorCode: normalized.code,
        elapsedMs: Date.now() - handshakeStartedMs,
        deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
      });
      throw normalized;
    }
    const handshakeContentInstanceId = handshake.contentInstanceId;
    if (!handshakeContentInstanceId) {
      throw new ExtensionError(ERROR_CODES.protocolError, "El Content Script nuevo no informó su generación después de la navegación.", {
        recoverable: false,
        details: { stage: "content_handshake", navigationRequestId: pending.navigationRequestId }
      });
    }
    const handshakeAt = new Date().toISOString();
    logger.info("whatsapp.open_conversation_stage", {
      operationId: `open:${contact.contactId}`,
      navigationRequestId: pending.navigationRequestId,
      stage: "content_handshake_confirmed",
      oldContentGeneration: pending.previousContentInstanceId,
      newContentGeneration: handshakeContentInstanceId,
      handshakeStartedAt: new Date(handshakeStartedMs).toISOString(),
      handshakeConfirmedAt: handshakeAt,
      elapsedMs: Date.now() - handshakeStartedMs,
      navigationToHandshakeMs: Date.now() - pending.navigationRequestedMs,
      deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
    });

    if (signal?.aborted) throw new DOMException("Operación cancelada", "AbortError");

    const semanticStartedMs = Date.now();
    let result;
    try {
      result = await this.transport.waitForSemanticReady(tab.id, remainingBudget("semantic_ready"), signal, {
        expectedContentInstanceId: handshakeContentInstanceId,
        navigationRequestId: pending.navigationRequestId
      });
      if (!result.operational) {
        if (result.qrDetected) throw new ExtensionError(ERROR_CODES.sessionNotReady, result.message);
        if (result.status === "incompatible") {
          const failed = Object.values(result.capabilities).find((capability) => capability.required && capability.state !== "available");
          throw new ExtensionError(ERROR_CODES.preflightFailed, result.message, {
            recoverable: false,
            ...(failed ? {
              details: {
                compatibilityDiagnostic: {
                  capability: failed.capability,
                  logicalStep: failed.logicalStep,
                  expectedStrategies: failed.attempts.map((attempt) => attempt.strategyId),
                  currentStrategiesAttempted: failed.attempts,
                  expectedSemanticElement: failed.expectedSemanticElement,
                  candidateCount: failed.candidateCount,
                  candidateSummaries: failed.candidateSummaries,
                  timestamp: result.checkedAt
                }
              }
            } : {})
          });
        }
        throw new ExtensionError(ERROR_CODES.interfaceLoading, result.message);
      }
      await this.recordOpenStage(contact, "semantic_ready", "confirmed", semanticStartedMs);
      logger.info("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        navigationRequestId: pending.navigationRequestId,
        stage: "semantic_ready_confirmed",
        semanticReadyAt: new Date().toISOString(),
        elapsedMs: Date.now() - semanticStartedMs,
        deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
      });
    } catch (error) {
      const normalized = stageError(error, "semantic_ready", Date.now() - semanticStartedMs);
      await this.recordOpenStage(contact, "semantic_ready", "failed", semanticStartedMs, normalized.code);
      throw normalized;
    }

    if (signal?.aborted) throw new DOMException("Operación cancelada", "AbortError");

    const proofOperationId = `prove:${contact.contactId}:${pending.navigationRequestId}`;
    const proofStartedMs = Date.now();
    const onAbort = (): void => {
      void this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappCancelOperation, { operationId: proofOperationId }, tab.id).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const proof = await this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappProveConversation, {
        operationId: proofOperationId,
        phoneDigits: contact.phoneDigits,
        navigationRequestId: pending.navigationRequestId,
        timeoutMs: Math.min(remainingBudget("conversation_proof"), CONVERSATION_PROOF_BUDGET_MS),
        requestedNavigationAt: pending.requestedNavigationAt,
        navigationObservedAt: pending.navigationObservedAt ?? handshakeAt,
        ...(result.contentInstanceId ? { expectedContentInstanceId: result.contentInstanceId } : {})
      }, this.requireBoundTabId());
      await this.recordOpenStage(contact, "conversation_proof", "confirmed", proofStartedMs);
      logger.info("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        navigationRequestId: pending.navigationRequestId,
        stage: "conversation_proof_confirmed",
        conversationProofAt: new Date().toISOString(),
        proofLevel: proof.proofLevel,
        proofStrategy: proof.evidence,
        elapsedMs: Date.now() - proofStartedMs,
        totalOpenConversationMs: Date.now() - operationStartedMs,
        deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
      });
      this.pendingConversationOpen = null;
    } catch (error) {
      const normalized = stageError(error, "conversation_proof", Date.now() - proofStartedMs);
      await this.recordOpenStage(contact, "conversation_proof", "failed", proofStartedMs, normalized.code);
      logger.warn("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        navigationRequestId: pending.navigationRequestId,
        stage: "conversation_proof_failed",
        errorCode: normalized.code,
        proofFailureReason: normalized.details?.proofFailureReason ?? null,
        elapsedMs: Date.now() - proofStartedMs,
        deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
      });
      throw normalized;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private requireBoundTabId(): number {
    if (this.whatsappTabId === null) {
      throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "El contacto activo no tiene una pestaña de WhatsApp vinculada.");
    }
    return this.whatsappTabId;
  }

  async sendImage(step: ImageContactStep, context: StepExecutionContext): Promise<StepExecutionResult> {
    const stored = await this.blobs.getImage(context.checkpoint.campaignId, step.image.imageId);
    if (!stored) {
      return {
        outcome: "missing_resource",
        error: serializeError(new ExtensionError(ERROR_CODES.imageMissing, "La imagen temporal ya no está disponible."))
      };
    }

    const settleDelayMs = imageSettleDelayMs(step);
    const confirmationTimeoutMs = Math.min(context.timeoutMs, IMAGE_CONFIRMATION_BUDGET_MS);
    try {
      const data = await stored.blob.arrayBuffer();
      await waitForUiSettle(settleDelayMs, context.signal);
      const result = await this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappSendImage, {
        operationId: step.operationId,
        expectedPhoneDigits: context.checkpoint.contact.phoneDigits,
        imageId: step.image.imageId,
        name: step.image.name,
        type: step.image.type,
        size: step.image.size,
        dataBase64: arrayBufferToBase64(data),
        imageLoadTimeoutMs: context.imageLoadTimeoutMs,
        previewTimeoutMs: context.previewTimeoutMs,
        confirmationTimeoutMs,
        checkpointRequired: true
      }, this.requireBoundTabId());
      return {
        outcome: "confirmed",
        verification: {
          ...result.verification,
          details: {
            ...(result.verification.details ?? {}),
            imageOrder: step.image.order,
            preSendSettleMs: settleDelayMs,
            imageConfirmationTimeoutMs: confirmationTimeoutMs
          }
        }
      };
    } catch (error) {
      return imageExecutionError(error, step, settleDelayMs, confirmationTimeoutMs);
    }
  }

  async sendText(step: TextContactStep, context: StepExecutionContext): Promise<StepExecutionResult> {
    const settleDelayMs = context.checkpoint.lastConfirmedStepId?.startsWith("image-")
      ? POST_MEDIA_TEXT_SETTLE_MS
      : 0;
    try {
      if (settleDelayMs > 0) await waitForUiSettle(settleDelayMs, context.signal);
      const result = await this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappSendText, {
        operationId: step.operationId,
        phoneDigits: context.checkpoint.contact.phoneDigits,
        message: step.text,
        timeoutMs: context.timeoutMs,
        checkpointRequired: true
      }, this.requireBoundTabId());
      const sentExecuted = result.verification.sent === true || result.verification.confirmed === true;
      if (!result.success || !sentExecuted) {
        throw new ExtensionError(ERROR_CODES.verificationFailed, "WhatsApp no confirmó la ejecución del envío de texto.");
      }
      const details = {
        postMediaTextSettleMs: settleDelayMs,
        verificationOutcome: result.verification.outcome,
        verificationConfidence: result.verification.confidence,
        verificationElapsedMs: result.verification.verificationElapsedMs ?? null,
        stableIdObserved: result.verification.stableIdObserved === true,
        newOutgoingObserved: result.verification.newOutgoingObserved === true,
        exactTextObserved: result.verification.exactTextObserved === true,
        composerConsumed: result.verification.composerConsumed === true,
        recipientStillVerified: result.verification.recipientStillVerified === true,
        sendAttempted: true,
        observerMutationCount: result.verification.observerMutationCount ?? 0,
        candidateOutgoingCount: result.verification.candidateOutgoingCount ?? 0,
        sendClickAt: result.verification.sendClickAt ?? null,
        firstOutgoingMutationAt: result.verification.firstOutgoingMutationAt ?? null,
        strongConfirmedAt: result.verification.strongConfirmedAt ?? null,
        causalConfirmedAt: result.verification.causalConfirmedAt ?? null,
        verificationTimeoutAt: result.verification.verificationTimeoutAt ?? null
      };
      if (result.verification.outcome === "sent_unverified") {
        return {
outcome: "sent_unverified",
verification: {
  outcome: "sent_unverified",
  confidence: "unverified",
  method: result.verification.method,
  observedAt: result.verification.observedAt ?? result.completedAt,
  sendAttempted: true,
  details
}
        };
      }
      if (!result.verification.confirmed) {
        throw new ExtensionError(ERROR_CODES.verificationFailed, "WhatsApp no confirmó el texto saliente.", {
details: { ...details, sendAttempted: true }
        });
      }
      return {
        outcome: "confirmed",
        verification: {
outcome: "confirmed",
confidence: result.verification.confidence === "strong" ? "strong" : "causal",
method: result.verification.method,
observedAt: result.verification.observedAt ?? result.completedAt,
sendAttempted: true,
...(result.verification.messageElementId ? { outgoingMessageId: result.verification.messageElementId } : {}),
details
        }
      };
    } catch (error) {
      const normalized = toExtensionError(error);
      return executionError(new ExtensionError(normalized.code, normalized.message, {
        recoverable: normalized.recoverable,
        cause: error,
        details: { ...(normalized.details ?? {}), postMediaTextSettleMs: settleDelayMs }
      }));
    }
  }

  async reconcile(step: ContactStep, context: StepExecutionContext): Promise<StepReconciliationResult> {
    return this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappReconcileStep, {
      kind: step.kind,
      operationId: step.operationId,
      expectedPhoneDigits: context.checkpoint.contact.phoneDigits,
      baselineOutgoingIds: step.verification?.baselineOutgoingIds ?? [],
      ...(step.kind === "text" ? { message: step.text } : {}),
      timeoutMs: context.timeoutMs
    }, this.requireBoundTabId());
  }
}
