import type { SerializedExtensionError } from "../shared/errors";

export type ContactStepKind = "image" | "text";
export type ContactStepStatus =
  | "pending"
  | "in_progress"
  | "verification_pending"
  | "confirmed"
  | "failed"
  | "images_required";

export type ContactProcessStatus =
  | "pending"
  | "opening_chat"
  | "running"
  | "paused"
  | "images_required"
  | "completed"
  | "failed";

export type ContactPauseReason =
  | "max_attempts"
  | "verification_pending"
  | "images_required"
  | "open_conversation_failed"
  | "manual_pause"
  | "non_recoverable_error";

export interface ContactTarget {
  contactId: string;
  name?: string;
  phoneDigits: string;
  maskedPhone: string;
  /**
   * Pestaña de WhatsApp Web vinculada de forma duradera al contacto activo.
   * Se persiste dentro del checkpoint para que un reinicio del Service Worker
   * nunca seleccione silenciosamente otra pestaña de WhatsApp.
   */
  whatsappTabId?: number;
}

export interface StepVerification {
  outcome: "confirmed" | "not_sent" | "ambiguous";
  method: string;
  observedAt: string;
  sendAttempted: boolean;
  outgoingMessageId?: string;
  baselineOutgoingIds?: string[];
  details?: Record<string, unknown>;
}

interface BaseContactStep {
  id: string;
  operationId: string;
  position: number;
  kind: ContactStepKind;
  status: ContactStepStatus;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  lastAttemptAt?: string;
  verification?: StepVerification;
  error?: SerializedExtensionError;
}

export interface ImageContactStep extends BaseContactStep {
  kind: "image";
  image: {
    imageId: string;
    order: number;
    name: string;
    type: string;
    size: number;
  };
}

export interface TextContactStep extends BaseContactStep {
  kind: "text";
  text: string;
}

export type ContactStep = ImageContactStep | TextContactStep;

export interface StepTechnicalRecord {
  timestamp: string;
  campaignId: string;
  contactId: string;
  stepId: string;
  attempt: number;
  result: "started" | "confirmed" | "failed" | "ambiguous" | "not_sent" | "missing_resource";
  verificationMethod?: string;
  errorCode?: string;
}

export interface ContactProcessCheckpoint {
  schemaVersion: 1;
  checkpointId: string;
  campaignId: string;
  campaignName: string;
  contact: ContactTarget;
  steps: ContactStep[];
  status: ContactProcessStatus;
  currentStepId: string | null;
  lastConfirmedStepId: string | null;
  /** Total de aperturas realizadas, útil para diagnóstico. */
  openConversationAttempts: number;
  /**
   * Presupuesto de aperturas FALLIDAS. Es opcional para rehidratar checkpoints 0.9.3;
   * una apertura confirmada no consume este budget y no bloquea reconciliaciones futuras.
   */
  openConversationFailures?: number;
  pauseReason?: ContactPauseReason;
  error?: SerializedExtensionError;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  history: StepTechnicalRecord[];
}

export interface StepExecutionContext {
  checkpoint: ContactProcessCheckpoint;
  timeoutMs: number;
  imageLoadTimeoutMs: number;
  previewTimeoutMs: number;
  signal?: AbortSignal;
}

export type StepExecutionResult =
  | { outcome: "confirmed"; verification: StepVerification }
  | { outcome: "ambiguous"; verification: StepVerification; error?: SerializedExtensionError }
  | { outcome: "failed"; error: SerializedExtensionError; recoverable: boolean; sendAttempted: false }
  | { outcome: "missing_resource"; error: SerializedExtensionError };

export type StepReconciliationResult =
  | { outcome: "confirmed"; verification: StepVerification }
  | { outcome: "not_sent"; verification: StepVerification }
  | { outcome: "ambiguous"; verification: StepVerification };

export interface ContactAdapter {
  openConversation(contact: ContactTarget, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  sendImage(step: ImageContactStep, context: StepExecutionContext): Promise<StepExecutionResult>;
  sendText(step: TextContactStep, context: StepExecutionContext): Promise<StepExecutionResult>;
  reconcile(step: ContactStep, context: StepExecutionContext): Promise<StepReconciliationResult>;
}

export interface ContactCheckpointRepository {
  loadActive(): Promise<ContactProcessCheckpoint | null>;
  saveActive(checkpoint: ContactProcessCheckpoint): Promise<ContactProcessCheckpoint>;
  clearActive(): Promise<void>;
}
