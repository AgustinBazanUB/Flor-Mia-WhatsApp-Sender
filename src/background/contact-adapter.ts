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

interface PendingConversationOpen {
  contactId: string;
  phoneDigits: string;
  tabId: number;
  previousContentInstanceId: string;
  requestedNavigationAt: string;
  navigationRequestedMs: number;
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
    stage: "navigation" | "content_handshake" | "conversation_proof",
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
      // Una falla de telemetría local nunca debe alterar la ejecución ni la seguridad del envío.
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
      try {
        const navigation = await this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, {
          operationId: `open:${contact.contactId}`,
          phoneDigits: contact.phoneDigits
        }, tab.id);
        pending = {
          contactId: contact.contactId,
          phoneDigits: contact.phoneDigits,
          tabId: tab.id,
          previousContentInstanceId: navigation.contentInstanceId,
          requestedNavigationAt: navigation.requestedNavigationAt,
          navigationRequestedMs: Date.now()
        };
        this.pendingConversationOpen = pending;
        await this.recordOpenStage(contact, "navigation", "confirmed", navigationStartedMs);
        logger.info("whatsapp.open_conversation_stage", {
          operationId: `open:${contact.contactId}`,
          stage: "navigation_requested",
          elapsedMs: Date.now() - operationStartedMs
        });
      } catch (error) {
        const normalized = stageError(error, "navigation", Date.now() - navigationStartedMs);
        await this.recordOpenStage(contact, "navigation", "failed", navigationStartedMs, normalized.code);
        throw normalized;
      }
    } else {
      await this.recordOpenStage(contact, "navigation", "reused", Date.now());
      logger.debug("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        stage: "reuse_pending_navigation",
        elapsedMs: Date.now() - operationStartedMs
      });
    }

    const handshakeStartedMs = Date.now();
    let result;
    try {
      result = await this.transport.waitForContent(tab.id, timeoutMs, signal, {
        previousContentInstanceId: pending.previousContentInstanceId,
        purpose: "content_handshake"
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
      await this.recordOpenStage(contact, "content_handshake", "confirmed", handshakeStartedMs);
    } catch (error) {
      const normalized = stageError(error, "content_handshake", Date.now() - handshakeStartedMs);
      if (normalized.code === ERROR_CODES.whatsappNotOpen) this.pendingConversationOpen = null;
      await this.recordOpenStage(contact, "content_handshake", "failed", handshakeStartedMs, normalized.code);
      logger.warn("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        stage: "content_handshake_failed",
        errorCode: normalized.code,
        elapsedMs: Date.now() - handshakeStartedMs
      });
      throw normalized;
    }
    const handshakeAt = new Date().toISOString();
    logger.info("whatsapp.open_conversation_stage", {
      operationId: `open:${contact.contactId}`,
      stage: "content_handshake_confirmed",
      elapsedMs: Date.now() - handshakeStartedMs,
      navigationToHandshakeMs: Date.now() - pending.navigationRequestedMs
    });

    if (signal?.aborted) throw new DOMException("Operación cancelada", "AbortError");

    const proofStartedMs = Date.now();
    try {
      await this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappProveConversation, {
        operationId: `prove:${contact.contactId}`,
        phoneDigits: contact.phoneDigits,
        timeoutMs: Math.min(timeoutMs, 15_000),
        requestedNavigationAt: pending.requestedNavigationAt,
        navigationObservedAt: handshakeAt,
        ...(result.contentInstanceId ? { expectedContentInstanceId: result.contentInstanceId } : {})
      }, this.requireBoundTabId());
      await this.recordOpenStage(contact, "conversation_proof", "confirmed", proofStartedMs);
      logger.info("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        stage: "conversation_proof_confirmed",
        elapsedMs: Date.now() - proofStartedMs,
        totalOpenConversationMs: Date.now() - operationStartedMs
      });
      this.pendingConversationOpen = null;
    } catch (error) {
      const normalized = stageError(error, "conversation_proof", Date.now() - proofStartedMs);
      await this.recordOpenStage(contact, "conversation_proof", "failed", proofStartedMs, normalized.code);
      logger.warn("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        stage: "conversation_proof_failed",
        errorCode: normalized.code,
        elapsedMs: Date.now() - proofStartedMs
      });
      throw normalized;
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
    try {
      const data = await stored.blob.arrayBuffer();
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
        confirmationTimeoutMs: context.timeoutMs,
        checkpointRequired: true
      }, this.requireBoundTabId());
      return { outcome: "confirmed", verification: result.verification };
    } catch (error) {
      return executionError(error);
    }
  }

  async sendText(step: TextContactStep, context: StepExecutionContext): Promise<StepExecutionResult> {
    try {
      const result = await this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappSendText, {
        operationId: step.operationId,
        phoneDigits: context.checkpoint.contact.phoneDigits,
        message: step.text,
        timeoutMs: context.timeoutMs,
        checkpointRequired: true
      }, this.requireBoundTabId());
      if (!result.success || !result.verification.confirmed) {
        throw new ExtensionError(ERROR_CODES.verificationFailed, "WhatsApp no confirmó el texto saliente.");
      }
      return {
        outcome: "confirmed",
        verification: {
          outcome: "confirmed",
          method: result.verification.method,
          observedAt: result.completedAt,
          sendAttempted: true,
          ...(result.verification.messageElementId ? { outgoingMessageId: result.verification.messageElementId } : {})
        }
      };
    } catch (error) {
      return executionError(error);
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
