import { ERROR_CODES, ExtensionError, serializeError } from "../shared/errors";
import type {
  ContactAdapter,
  ContactStep,
  ImageContactStep,
  StepExecutionContext,
  StepExecutionResult,
  StepReconciliationResult,
  TextContactStep
} from "./types";

export const DEVELOPMENT_FAULTS = [
  "none",
  "image-2-fail-once",
  "image-2-fail-always",
  "image-2-timeout-once",
  "image-2-attachment-fail-once",
  "image-2-preview-fail-once",
  "image-2-ambiguous",
  "image-1-missing"
] as const;
export type DevelopmentFault = (typeof DEVELOPMENT_FAULTS)[number];

export function isDevelopmentFault(value: unknown): value is DevelopmentFault {
  return typeof value === "string" && (DEVELOPMENT_FAULTS as readonly string[]).includes(value);
}

/**
 * Aislado para pruebas manuales iniciadas explícitamente desde el popup.
 * El flujo recibido desde la Web-App nunca aplica este decorador.
 */
export class FaultInjectingContactAdapter implements ContactAdapter {
  private readonly calls = new Map<string, number>();

  constructor(private readonly inner: ContactAdapter, private readonly fault: DevelopmentFault) {}

  openConversation(contact: Parameters<ContactAdapter["openConversation"]>[0], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return this.inner.openConversation(contact, timeoutMs, signal);
  }

  sendImage(step: ImageContactStep, context: StepExecutionContext): Promise<StepExecutionResult> {
    const count = (this.calls.get(step.id) ?? 0) + 1;
    this.calls.set(step.id, count);
    if (this.fault === "image-1-missing" && step.id === "image-1") {
      return Promise.resolve({
        outcome: "missing_resource",
        error: serializeError(new ExtensionError(ERROR_CODES.imageMissing, "Fallo simulado: archivo temporal ausente."))
      });
    }
    if (step.id === "image-2" && (this.fault === "image-2-fail-always" || (this.fault === "image-2-fail-once" && count === 1))) {
      return Promise.resolve({
        outcome: "failed",
        error: serializeError(new ExtensionError(ERROR_CODES.imageLoadFailed, "Fallo simulado antes de enviar la segunda imagen.")),
        recoverable: true,
        sendAttempted: false
      });
    }
    if (step.id === "image-2" && count === 1 && this.fault === "image-2-timeout-once") {
      return Promise.resolve({
        outcome: "failed",
        error: serializeError(new ExtensionError(ERROR_CODES.timeout, "Fallo simulado: timeout de carga de imagen.")),
        recoverable: true,
        sendAttempted: false
      });
    }
    if (step.id === "image-2" && count === 1 && this.fault === "image-2-attachment-fail-once") {
      return Promise.resolve({
        outcome: "failed",
        error: serializeError(new ExtensionError(ERROR_CODES.attachmentUnavailable, "Fallo simulado: mecanismo de adjuntos no disponible.")),
        recoverable: true,
        sendAttempted: false
      });
    }
    if (step.id === "image-2" && count === 1 && this.fault === "image-2-preview-fail-once") {
      return Promise.resolve({
        outcome: "failed",
        error: serializeError(new ExtensionError(ERROR_CODES.previewUnavailable, "Fallo simulado: el preview no terminó de cargar.")),
        recoverable: true,
        sendAttempted: false
      });
    }
    if (step.id === "image-2" && this.fault === "image-2-ambiguous" && count === 1) {
      return Promise.resolve({
        outcome: "ambiguous",
        verification: {
          outcome: "ambiguous",
          method: "development-fault-injection",
          observedAt: new Date().toISOString(),
          sendAttempted: true
        }
      });
    }
    return this.inner.sendImage(step, context);
  }

  sendText(step: TextContactStep, context: StepExecutionContext): Promise<StepExecutionResult> {
    return this.inner.sendText(step, context);
  }

  reconcile(step: ContactStep, context: StepExecutionContext): Promise<StepReconciliationResult> {
    if (this.fault === "image-2-ambiguous" && step.id === "image-2") {
      return Promise.resolve({
        outcome: "ambiguous",
        verification: {
          outcome: "ambiguous",
          method: "development-fault-injection",
          observedAt: new Date().toISOString(),
          sendAttempted: true
        }
      });
    }
    return this.inner.reconcile(step, context);
  }
}
