import type {
  ContactAdapter,
  ContactStep,
  ImageContactStep,
  StepExecutionContext,
  StepExecutionResult,
  StepReconciliationResult,
  TextContactStep
} from "../engine/types";
import { ERROR_CODES, ExtensionError, serializeError, toExtensionError } from "../shared/errors";
import { INTERNAL_MESSAGE_TYPES } from "../shared/protocol";
import { arrayBufferToBase64 } from "../shared/serialization";
import type { CampaignBlobStore } from "../storage/blob-store";
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

export class ChromeWhatsAppContactAdapter implements ContactAdapter {
  constructor(
    private readonly blobs: CampaignBlobStore,
    private readonly transport: WhatsAppTransport = new WhatsAppTransport()
  ) {}

  async openConversation(contact: Parameters<ContactAdapter["openConversation"]>[0], timeoutMs: number): Promise<void> {
    const tab = await this.transport.requireTab();
    await this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, {
      operationId: `open:${contact.contactId}`,
      phoneDigits: contact.phoneDigits
    }, tab.id);
    const result = await this.transport.waitForContent(tab.id, timeoutMs);
    if (!result.operational) {
      throw new ExtensionError(result.qrDetected ? ERROR_CODES.sessionNotReady : ERROR_CODES.interfaceLoading, result.message);
    }
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
        imageId: step.image.imageId,
        name: step.image.name,
        type: step.image.type,
        size: step.image.size,
        dataBase64: arrayBufferToBase64(data),
        imageLoadTimeoutMs: context.imageLoadTimeoutMs,
        previewTimeoutMs: context.previewTimeoutMs,
        confirmationTimeoutMs: context.timeoutMs,
        checkpointRequired: true
      });
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
      });
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
      baselineOutgoingIds: step.verification?.baselineOutgoingIds ?? [],
      ...(step.kind === "text" ? { message: step.text } : {}),
      timeoutMs: context.timeoutMs
    });
  }
}
