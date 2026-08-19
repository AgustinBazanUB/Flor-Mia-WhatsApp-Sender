import { createContactCheckpoint } from "../engine/steps";
import type { ContactCheckpointRepository, ContactProcessCheckpoint, ContactStep } from "../engine/types";
import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { createId } from "../shared/ids";
import { assertCampaignTransition } from "./campaign-state-machine";
import type {
  CampaignBlockReason,
  CampaignRepository,
  CampaignState,
  DailyLimitRepository,
  DailyLimitState
} from "./campaign-types";
import { COMPATIBILITY_ERROR_CODES } from "../compatibility/diagnostic-error";
import { hasUnresolvedSendEvidence } from "../engine/checkpoint-safety";
import {
  campaignContactFailureClass,
  campaignFailureRecord,
  checkpointTechnicalError,
  LOCAL_FAILURE_CIRCUIT_THRESHOLD
} from "./failure-policy";

export type CampaignCompletionFaultPoint =
  | "after_contact_completed"
  | "after_daily_increment"
  | "before_campaign_save"
  | "after_campaign_save"
  | "before_checkpoint_clear";

export interface CampaignContactRunner {
  run(
    checkpoint: ContactProcessCheckpoint,
    shouldPause: () => Promise<boolean>
  ): Promise<ContactProcessCheckpoint>;
}

export interface CampaignEngineDependencies {
  campaigns: CampaignRepository;
  dailyLimit: DailyLimitRepository;
  contactCheckpoints: ContactCheckpointRepository;
  contactRunner: CampaignContactRunner;
  healthCheck?: (campaign: CampaignState) => Promise<{
    healthy: boolean;
    temporary?: boolean;
    blockCode?: CampaignBlockReason["code"];
    error?: CampaignBlockReason["error"];
    message?: string;
  }>;
  now?: () => Date;
  onCampaign?: (campaign: CampaignState) => Promise<void> | void;
  completionFault?: (point: CampaignCompletionFaultPoint) => Promise<void> | void;
}

const TERMINAL_STATUSES = new Set<CampaignState["status"]>(["stopped", "completed"]);

function block(
  code: CampaignBlockReason["code"],
  message: string,
  at: string,
  recoverable: boolean,
  error?: CampaignBlockReason["error"]
): CampaignBlockReason {
  return { code, message, at, recoverable, ...(error ? { error } : {}) };
}

function checkpointBlock(checkpoint: ContactProcessCheckpoint, at: string): {
  status: CampaignState["status"];
  reason: CampaignBlockReason;
  recipientStatus: CampaignState["recipients"][number]["status"];
} {
  const technicalError = checkpointTechnicalError(checkpoint);
  if (checkpoint.status === "images_required") {
    return {
      status: "images_required",
      recipientStatus: "images_required",
      reason: block("images_required", "Faltan imágenes temporales para continuar la campaña.", at, true, technicalError)
    };
  }
  if (checkpoint.pauseReason === "verification_pending" || hasUnresolvedSendEvidence(checkpoint)) {
    return {
      status: "paused",
      recipientStatus: "paused",
      reason: block("contact_ambiguous", "No pudimos confirmar el resultado del último envío. La campaña quedó pausada para evitar duplicados.", at, true, technicalError)
    };
  }
  const code = technicalError?.code;
  if (code === ERROR_CODES.contactContextUnverified) {
    return {
      status: "paused",
      recipientStatus: "paused",
      reason: block(
        "contact_paused",
        "No pudimos confirmar que WhatsApp abrió el contacto correcto. La campaña se pausó para evitar enviar el mensaje a otra persona.",
        at,
        true,
        technicalError
      )
    };
  }
  if (code && COMPATIBILITY_ERROR_CODES.has(code)) {
    return {
      status: "paused",
      recipientStatus: "paused",
      reason: block(
        "whatsapp_ui_changed",
        "WhatsApp cambió y necesitamos revisar la conexión antes de continuar.",
        at,
        true,
        technicalError
      )
    };
  }
  if (code === ERROR_CODES.whatsappNotOpen) {
    return {
      status: "paused",
      recipientStatus: "paused",
      reason: block("whatsapp_tab_closed", "WhatsApp Web no está abierto. Abrilo para continuar.", at, true, technicalError)
    };
  }
  if (code === ERROR_CODES.sessionNotReady) {
    return {
      status: "paused",
      recipientStatus: "paused",
      reason: block("whatsapp_session_closed", "WhatsApp necesita iniciar sesión. Abrí WhatsApp Web y escaneá el código QR.", at, true, technicalError)
    };
  }
  if (code === ERROR_CODES.interfaceLoading || code === ERROR_CODES.timeout) {
    return {
      status: "paused",
      recipientStatus: "paused",
      reason: block("whatsapp_reloading", "WhatsApp Web todavía se está cargando. La campaña quedó pausada para continuar de forma segura.", at, true, technicalError)
    };
  }
  if (checkpoint.status === "failed") {
    return {
      status: "error",
      recipientStatus: "error",
      reason: block("contact_failed", "Necesita revisión. El contacto se detuvo de forma segura.", at, false, technicalError)
    };
  }
  return {
    status: "paused",
    recipientStatus: "paused",
    reason: block("contact_paused", "La campaña quedó pausada antes de continuar con este contacto.", at, true, technicalError)
  };
}

function terminalRecipient(status: CampaignState["recipients"][number]["status"]): boolean {
  return status === "completed" || status === "error";
}

function resetFailureCircuit(campaign: CampaignState, at: string): CampaignState["failureCircuit"] {
  return {
    signature: null,
    consecutive: 0,
    threshold: campaign.failureCircuit?.threshold ?? LOCAL_FAILURE_CIRCUIT_THRESHOLD,
    updatedAt: at
  };
}

function retryCheckpoint(checkpoint: ContactProcessCheckpoint, at: string): ContactProcessCheckpoint {
  if (hasUnresolvedSendEvidence(checkpoint)) {
    throw new ExtensionError(ERROR_CODES.ambiguousResult, "No se puede reintentar mientras el último envío siga siendo ambiguo.", {
      recoverable: true
    });
  }
  const steps = checkpoint.steps.map((step): ContactStep => {
    if (step.status === "confirmed") return { ...step };
    return {
      ...step,
      status: "pending",
      attempts: 0,
      verification: undefined,
      error: undefined,
      completedAt: undefined
    } as ContactStep;
  });
  return {
    ...checkpoint,
    status: "pending",
    pauseReason: undefined,
    currentStepId: null,
    openConversationFailures: 0,
    openConversationAttempts: 0,
    error: undefined,
    completedAt: undefined,
    steps,
    updatedAt: at
  };
}

export class CampaignEngine {
  private readonly now: () => Date;

  constructor(private readonly dependencies: CampaignEngineDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  private async requireCampaign(campaignId: string): Promise<CampaignState> {
    const campaign = await this.dependencies.campaigns.loadActive();
    if (!campaign || campaign.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña solicitada no coincide con la campaña activa.");
    }
    return campaign;
  }

  private async save(current: CampaignState, patch: Partial<CampaignState>): Promise<CampaignState> {
    const nextStatus = patch.status ?? current.status;
    assertCampaignTransition(current.status, nextStatus);
    const recipients = patch.recipients ?? current.recipients;
    const completedRecipients = recipients.filter((recipient) => recipient.status === "completed").length;
    const now = this.now().toISOString();
    const next: CampaignState = {
      ...current,
      ...patch,
      recipients,
      completedRecipients,
      sequence: current.sequence + 1,
      updatedAt: now
    };
    const saved = await this.dependencies.campaigns.saveActive(next);
    await this.dependencies.onCampaign?.(saved);
    return saved;
  }

  private async completionFault(point: CampaignCompletionFaultPoint): Promise<void> {
    await this.dependencies.completionFault?.(point);
  }

  private waitAfterProcessed(
    campaign: CampaignState,
    processedInBatch: number,
    daily: DailyLimitState,
    at: string
  ): Partial<CampaignState> {
    if (campaign.stopRequested) return { status: "stopped", wait: null, stoppedAt: at };
    if (campaign.pauseRequested) return { status: "paused", wait: null };
    if (daily.remaining <= 0) {
      return {
        status: "daily_limit_reached",
        wait: null,
        blockReason: block("daily_limit_reached", "El contacto activo finalizó; el siguiente queda bloqueado por el límite diario.", at, true)
      };
    }
    const batchBoundary = processedInBatch >= campaign.policy.contactsPerBatch;
    const delayMs = batchBoundary ? campaign.policy.delayBetweenBatchesMs : campaign.policy.delayBetweenContactsMs;
    const scheduledAt = this.now();
    return {
      status: batchBoundary ? "waiting_batch" : "waiting_contact",
      batchNumber: batchBoundary ? campaign.batchNumber + 1 : campaign.batchNumber,
      contactsCompletedInBatch: batchBoundary ? 0 : processedInBatch,
      wait: {
        kind: batchBoundary ? "between_batches" : "between_contacts",
        scheduledAt: scheduledAt.toISOString(),
        until: new Date(scheduledAt.getTime() + delayMs).toISOString()
      }
    };
  }

  private async applyCompletedCheckpoint(
    campaign: CampaignState,
    recipient: CampaignState["recipients"][number]
  ): Promise<CampaignState> {
    await this.completionFault("after_contact_completed");
    const daily = await this.dependencies.dailyLimit.recordCompletion(
      campaign.policy.dailyContactLimit,
      `${campaign.campaignId}:${recipient.recipientId}`,
      this.now()
    );
    await this.completionFault("after_daily_increment");
    const completedAt = this.now().toISOString();
    const recipients = campaign.recipients.map((item) => item.recipientId === recipient.recipientId
      ? { ...item, status: "completed" as const, completedAt, error: undefined, failure: undefined }
      : item);
    const allProcessed = recipients.every((item) => terminalRecipient(item.status));
    const processedInBatch = campaign.contactsCompletedInBatch + 1;
    const basePatch: Partial<CampaignState> = {
      recipients,
      dailyLimit: daily,
      lastCompletedContactId: recipient.recipientId,
      activeContactId: null,
      currentRecipientIndex: allProcessed ? null : recipient.position - 1,
      contactsCompletedInBatch: processedInBatch,
      blockReason: null,
      failureCircuit: resetFailureCircuit(campaign, completedAt)
    };
    const terminalPatch: Partial<CampaignState> = allProcessed
      ? { status: "completed", wait: null, completedAt }
      : this.waitAfterProcessed(campaign, processedInBatch, daily, completedAt);
    await this.completionFault("before_campaign_save");
    const saved = await this.save(campaign, { ...basePatch, ...terminalPatch });
    await this.completionFault("after_campaign_save");
    await this.completionFault("before_checkpoint_clear");
    await this.dependencies.contactCheckpoints.clearActive();
    return saved;
  }

  private async applySafeFailedCheckpoint(
    campaign: CampaignState,
    recipient: CampaignState["recipients"][number],
    checkpoint: ContactProcessCheckpoint
  ): Promise<CampaignState> {
    const failedAt = this.now().toISOString();
    const failure = campaignFailureRecord(checkpoint, failedAt);
    if (failure.sendAttempted || failure.ambiguous) {
      throw new ExtensionError(ERROR_CODES.ambiguousResult, "El contacto conserva evidencia de envío y no puede marcarse como fallido seguro.", {
        recoverable: false
      });
    }
    const technicalError = checkpointTechnicalError(checkpoint);
    const recipients = campaign.recipients.map((item) => item.recipientId === recipient.recipientId
      ? {
          ...item,
          status: "error" as const,
          completedAt: failedAt,
          error: technicalError,
          failure: { ...failure, retryEligible: true }
        }
      : item);
    const previousCircuit = campaign.failureCircuit;
    const consecutive = previousCircuit?.signature === failure.signature ? previousCircuit.consecutive + 1 : 1;
    const threshold = previousCircuit?.threshold ?? LOCAL_FAILURE_CIRCUIT_THRESHOLD;
    const failureCircuit = { signature: failure.signature, consecutive, threshold, updatedAt: failedAt };
    const allProcessed = recipients.every((item) => terminalRecipient(item.status));
    const processedInBatch = campaign.contactsCompletedInBatch + 1;
    let terminalPatch: Partial<CampaignState>;
    if (campaign.stopRequested) {
      terminalPatch = { status: "stopped", wait: null, stoppedAt: failedAt, blockReason: null };
    } else if (campaign.pauseRequested) {
      terminalPatch = { status: "paused", wait: null, blockReason: block("manual_pause", "La campaña quedó pausada en una frontera segura.", failedAt, true) };
    } else if (consecutive >= threshold) {
      terminalPatch = {
        status: "paused",
        wait: null,
        blockReason: block(
          "repeated_contact_failures",
          `${consecutive} contactos consecutivos tuvieron el mismo problema técnico. La campaña se pausó para evitar fallar masivamente.`,
          failedAt,
          true,
          technicalError
        )
      };
    } else if (allProcessed) {
      terminalPatch = { status: "completed", wait: null, completedAt: failedAt, blockReason: null };
    } else {
      terminalPatch = this.waitAfterProcessed(campaign, processedInBatch, campaign.dailyLimit, failedAt);
    }
    const saved = await this.save(campaign, {
      recipients,
      activeContactId: null,
      currentRecipientIndex: allProcessed ? null : recipient.position - 1,
      contactsCompletedInBatch: processedInBatch,
      failureCircuit,
      ...terminalPatch
    });
    await this.dependencies.contactCheckpoints.clearActive();
    return saved;
  }

  async start(campaignId: string): Promise<CampaignState> {
    let campaign = await this.requireCampaign(campaignId);
    if (TERMINAL_STATUSES.has(campaign.status)) {
      throw new ExtensionError(ERROR_CODES.campaignStopped, "La campaña ya finalizó y no puede iniciarse nuevamente.", { recoverable: false });
    }
    const daily = await this.dependencies.dailyLimit.load(campaign.policy.dailyContactLimit, this.now());
    if (campaign.activeContactId === null && daily.remaining <= 0) {
      return this.save(campaign, {
        status: "daily_limit_reached",
        dailyLimit: daily,
        blockReason: block("daily_limit_reached", "Se alcanzó el límite diario de contactos completados.", this.now().toISOString(), true)
      });
    }
    if (campaign.status === "received") campaign = await this.save(campaign, { status: "ready", dailyLimit: daily });
    return this.save(campaign, {
      status: "running",
      dailyLimit: daily,
      pauseRequested: false,
      stopRequested: false,
      blockReason: null,
      wait: null,
      startedAt: campaign.startedAt ?? this.now().toISOString()
    });
  }

  async requestPause(campaignId: string): Promise<CampaignState> {
    const campaign = await this.requireCampaign(campaignId);
    if (TERMINAL_STATUSES.has(campaign.status)) return campaign;
    const active = campaign.activeContactId !== null;
    return this.save(campaign, {
      status: active ? "pause_requested" : "paused",
      pauseRequested: true,
      blockReason: block("manual_pause", "Pausa manual solicitada.", this.now().toISOString(), true)
    });
  }

  async resume(campaignId: string): Promise<CampaignState> {
    let campaign = await this.requireCampaign(campaignId);
    if (TERMINAL_STATUSES.has(campaign.status)) {
      throw new ExtensionError(ERROR_CODES.campaignStopped, "La campaña finalizada no puede reanudarse.", { recoverable: false });
    }
    if (campaign.status === "images_required") {
      throw new ExtensionError(ERROR_CODES.imageMissing, "La campaña requiere restaurar sus imágenes antes de reanudarse.");
    }
    if (campaign.status === "error") {
      throw new ExtensionError(ERROR_CODES.campaignStopped, "Usá Reintentar cuando el error sea recuperable; Reanudar no reinicia presupuestos de error.", { recoverable: true });
    }
    const daily = await this.dependencies.dailyLimit.load(campaign.policy.dailyContactLimit, this.now());
    if (campaign.activeContactId === null && daily.remaining <= 0) {
      return this.save(campaign, {
        status: "daily_limit_reached",
        dailyLimit: daily,
        pauseRequested: false,
        blockReason: block("daily_limit_reached", "Se alcanzó el límite diario de contactos completados.", this.now().toISOString(), true)
      });
    }
    const pendingWait = campaign.wait && Date.parse(campaign.wait.until) > this.now().getTime() ? campaign.wait : null;
    campaign = await this.save(campaign, {
      status: pendingWait?.kind === "between_batches" ? "waiting_batch" : pendingWait ? "waiting_contact" : "ready",
      pauseRequested: false,
      stopRequested: campaign.stopRequested,
      dailyLimit: daily,
      blockReason: null,
      wait: pendingWait
    });
    return pendingWait ? campaign : this.save(campaign, { status: "running" });
  }

  async retry(campaignId: string): Promise<CampaignState> {
    let campaign = await this.requireCampaign(campaignId);
    if (campaign.status === "stopped" || campaign.status === "completed") {
      throw new ExtensionError(ERROR_CODES.invalidInput, "Esta campaña no admite Reintentar. Usá Reintentar fallidos cuando haya terminado con problemas.");
    }
    const at = this.now().toISOString();
    const checkpoint = await this.dependencies.contactCheckpoints.loadActive();
    if (checkpoint?.campaignId === campaignId) {
      const retried = retryCheckpoint(checkpoint, at);
      await this.dependencies.contactCheckpoints.saveActive(retried);
      const activeId = campaign.activeContactId ?? checkpoint.contact.contactId;
      campaign = await this.save(campaign, {
        status: "running",
        activeContactId: activeId,
        currentRecipientIndex: campaign.recipients.findIndex((item) => item.recipientId === activeId),
        recipients: campaign.recipients.map((item) => item.recipientId === activeId
          ? { ...item, status: "active", error: undefined, failure: undefined }
          : item),
        pauseRequested: false,
        stopRequested: false,
        blockReason: null,
        wait: null,
        failureCircuit: resetFailureCircuit(campaign, at)
      });
      return campaign;
    }

    const failedRecipient = [...campaign.recipients].reverse().find((item) =>
      item.status === "error" && item.failure?.retryEligible === true && !item.failure.ambiguous && !item.failure.sendAttempted);
    if (!failedRecipient) {
      throw new ExtensionError(ERROR_CODES.invalidInput, "No hay un contacto fallido que pueda reintentarse sin riesgo de duplicado.");
    }
    return this.save(campaign, {
      status: "running",
      recipients: campaign.recipients.map((item) => item.recipientId === failedRecipient.recipientId
        ? { ...item, status: "pending", completedAt: undefined, error: undefined, failure: undefined }
        : item),
      activeContactId: null,
      currentRecipientIndex: null,
      pauseRequested: false,
      stopRequested: false,
      blockReason: null,
      wait: null,
      runToken: createId("campaign-run"),
      retryCycle: (campaign.retryCycle ?? 0) + 1,
      completedAt: undefined,
      failureCircuit: resetFailureCircuit(campaign, at)
    });
  }

  async retryFailed(campaignId: string): Promise<CampaignState> {
    const campaign = await this.requireCampaign(campaignId);
    if (campaign.status !== "completed") {
      throw new ExtensionError(ERROR_CODES.invalidInput, "Reintentar fallidos sólo está disponible al finalizar una campaña.");
    }
    const checkpoint = await this.dependencies.contactCheckpoints.loadActive();
    if (checkpoint?.campaignId === campaignId && hasUnresolvedSendEvidence(checkpoint)) {
      throw new ExtensionError(ERROR_CODES.ambiguousResult, "Existe un envío ambiguo pendiente. No se reintentará automáticamente.");
    }
    const retryableIds = new Set(campaign.recipients
      .filter((item) => item.status === "error" && item.failure?.retryEligible === true && !item.failure.ambiguous && !item.failure.sendAttempted)
      .map((item) => item.recipientId));
    if (retryableIds.size === 0) {
      throw new ExtensionError(ERROR_CODES.invalidInput, "No hay destinatarios fallidos con evidencia suficiente para un reintento seguro.");
    }
    if (checkpoint?.campaignId === campaignId) await this.dependencies.contactCheckpoints.clearActive();
    const at = this.now().toISOString();
    const daily = await this.dependencies.dailyLimit.load(campaign.policy.dailyContactLimit, this.now());
    const recipients = campaign.recipients.map((item) => retryableIds.has(item.recipientId)
      ? { ...item, status: "pending" as const, completedAt: undefined, error: undefined, failure: undefined }
      : item);
    return this.save(campaign, {
      status: daily.remaining <= 0 ? "daily_limit_reached" : "running",
      recipients,
      dailyLimit: daily,
      activeContactId: null,
      currentRecipientIndex: null,
      pauseRequested: false,
      stopRequested: false,
      blockReason: daily.remaining <= 0
        ? block("daily_limit_reached", "Se alcanzó el límite diario; los fallidos quedaron preparados para otro momento.", at, true)
        : null,
      wait: null,
      contactsCompletedInBatch: 0,
      runToken: createId("campaign-run"),
      retryCycle: (campaign.retryCycle ?? 0) + 1,
      completedAt: undefined,
      failureCircuit: resetFailureCircuit(campaign, at)
    });
  }

  async requestStop(campaignId: string): Promise<CampaignState> {
    const campaign = await this.requireCampaign(campaignId);
    if (TERMINAL_STATUSES.has(campaign.status)) return campaign;
    const contactStepInFlight = campaign.activeContactId !== null
      && ["running", "pause_requested"].includes(campaign.status);
    return this.save(campaign, {
      status: contactStepInFlight ? "pause_requested" : "stopped",
      stopRequested: true,
      pauseRequested: false,
      wait: null,
      blockReason: null,
      ...(contactStepInFlight ? {} : { stoppedAt: this.now().toISOString() })
    });
  }

  async recoverAfterServiceWorkerRestart(
    campaign: CampaignState,
    checkpoint: ContactProcessCheckpoint | null = null
  ): Promise<CampaignState> {
    if (checkpoint?.campaignId === campaign.campaignId && checkpoint.status === "completed") {
      const checkpointRecipient = campaign.recipients.find((recipient) => recipient.recipientId === checkpoint.contact.contactId);
      if (checkpointRecipient?.status === "completed") {
        await this.dependencies.contactCheckpoints.clearActive();
        return campaign;
      }
      if (checkpointRecipient && campaign.activeContactId === checkpointRecipient.recipientId) {
        return this.applyCompletedCheckpoint(campaign, checkpointRecipient);
      }
    }
    if (TERMINAL_STATUSES.has(campaign.status)) return campaign;
    if (campaign.status === "waiting_batch" || campaign.status === "waiting_contact") return campaign;
    if (["received", "paused", "daily_limit_reached", "images_required", "error"].includes(campaign.status)) return campaign;
    if (checkpoint && checkpoint.campaignId === campaign.campaignId) {
      const failureClass = campaignContactFailureClass(checkpoint);
      const activeRecipient = campaign.recipients.find((recipient) => recipient.recipientId === campaign.activeContactId);
      if (failureClass === "local_safe" && activeRecipient && checkpointTechnicalError(checkpoint)) {
        return this.applySafeFailedCheckpoint(campaign, activeRecipient, checkpoint);
      }
      const blocked = checkpointBlock(checkpoint, this.now().toISOString());
      if (["images_required", "paused", "failed"].includes(checkpoint.status)) {
        return this.save(campaign, {
          status: blocked.status,
          pauseRequested: blocked.status === "paused",
          blockReason: blocked.reason,
          recipients: campaign.recipients.map((recipient) => recipient.recipientId === campaign.activeContactId
            ? { ...recipient, status: blocked.recipientStatus, error: checkpoint.error }
            : recipient)
        });
      }
    }
    return this.save(campaign, {
      status: "paused",
      pauseRequested: true,
      blockReason: block(
        "service_worker_restarted",
        "La campaña quedó pausada después de recargar la extensión. Comprobá la conexión y usá Reintentar si el checkpoint confirma que todavía no se envió nada.",
        this.now().toISOString(),
        true
      )
    });
  }

  async markImagesRestored(campaignId: string): Promise<CampaignState> {
    const campaign = await this.requireCampaign(campaignId);
    if (campaign.status !== "images_required") return campaign;
    return this.save(campaign, {
      status: "paused",
      pauseRequested: false,
      blockReason: null,
      recipients: campaign.recipients.map((recipient) => recipient.recipientId === campaign.activeContactId
        ? { ...recipient, status: "paused", error: undefined }
        : recipient)
    });
  }

  async advance(campaignId: string): Promise<CampaignState> {
    let campaign = await this.requireCampaign(campaignId);
    if (TERMINAL_STATUSES.has(campaign.status) || ["paused", "images_required", "error", "daily_limit_reached", "received"].includes(campaign.status)) {
      return campaign;
    }
    if (campaign.stopRequested && campaign.activeContactId === null) {
      return this.save(campaign, { status: "stopped", wait: null, stoppedAt: this.now().toISOString() });
    }
    if (campaign.pauseRequested && campaign.activeContactId === null) {
      return this.save(campaign, { status: "paused", wait: null });
    }
    if (campaign.wait) {
      if (Date.parse(campaign.wait.until) > this.now().getTime()) return campaign;
      campaign = await this.save(campaign, { status: "running", wait: null });
    } else if (campaign.status !== "running" && campaign.status !== "pause_requested" && campaign.status !== "ready") {
      return campaign;
    }

    const existingCheckpoint = await this.dependencies.contactCheckpoints.loadActive();
    let recipient = campaign.activeContactId
      ? campaign.recipients.find((item) => item.recipientId === campaign.activeContactId)
      : undefined;
    if (!recipient) {
      const daily = await this.dependencies.dailyLimit.load(campaign.policy.dailyContactLimit, this.now());
      campaign = await this.save(campaign, { dailyLimit: daily });
      if (daily.remaining <= 0) {
        return this.save(campaign, {
          status: "daily_limit_reached",
          blockReason: block("daily_limit_reached", "Se alcanzó el límite diario; no se inició otro contacto.", this.now().toISOString(), true)
        });
      }
      if (this.dependencies.healthCheck) {
        const health = await this.dependencies.healthCheck(campaign);
        if (!health.healthy) {
          const blockCode = health.blockCode ?? (health.temporary ? "whatsapp_reloading" : "whatsapp_ui_changed");
          return this.save(campaign, {
            status: "paused",
            pauseRequested: true,
            blockReason: block(
              blockCode,
              health.message ?? (health.temporary
                ? "WhatsApp Web todavía está cargando; la campaña quedó pausada temporalmente."
                : "WhatsApp cambió y necesitamos revisar la conexión antes de continuar."),
              this.now().toISOString(),
              true,
              health.error
            )
          });
        }
      }
      recipient = campaign.recipients.find((item) => item.status === "pending");
      if (!recipient) {
        return this.save(campaign, {
          status: "completed",
          currentRecipientIndex: null,
          activeContactId: null,
          wait: null,
          completedAt: this.now().toISOString()
        });
      }
      if (existingCheckpoint) await this.dependencies.contactCheckpoints.clearActive();
      const startedAt = this.now().toISOString();
      campaign = await this.save(campaign, {
        status: "running",
        activeContactId: recipient.recipientId,
        currentRecipientIndex: recipient.position - 1,
        recipients: campaign.recipients.map((item) => item.recipientId === recipient!.recipientId
          ? { ...item, status: "active", startedAt: item.startedAt ?? startedAt, error: undefined, failure: undefined }
          : item)
      });
    } else if (recipient.status !== "active") {
      campaign = await this.save(campaign, {
        status: "running",
        recipients: campaign.recipients.map((item) => item.recipientId === recipient!.recipientId
          ? { ...item, status: "active", error: undefined }
          : item)
      });
      recipient = campaign.recipients.find((item) => item.recipientId === campaign.activeContactId)!;
    }

    let checkpoint = await this.dependencies.contactCheckpoints.loadActive();
    if (!checkpoint || checkpoint.campaignId !== campaign.campaignId || checkpoint.contact.contactId !== recipient.recipientId) {
      checkpoint = createContactCheckpoint({
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        contact: {
          contactId: recipient.recipientId,
          name: recipient.name,
          phoneDigits: recipient.phoneDigits,
          maskedPhone: recipient.maskedPhone
        },
        images: campaign.images,
        text: campaign.text,
        now: this.now().toISOString()
      });
      await this.dependencies.contactCheckpoints.saveActive(checkpoint);
    }

    if (checkpoint.status !== "completed") {
      checkpoint = await this.dependencies.contactRunner.run(checkpoint, async () => {
        const latest = await this.dependencies.campaigns.loadActive();
        return !latest || latest.campaignId !== campaignId || latest.pauseRequested || latest.stopRequested;
      });
    }

    campaign = await this.requireCampaign(campaignId);
    recipient = campaign.recipients.find((item) => item.recipientId === campaign.activeContactId) ?? recipient;
    if (checkpoint.status === "completed") {
      return this.applyCompletedCheckpoint(campaign, recipient);
    }

    if (hasUnresolvedSendEvidence(checkpoint)) {
      const blocked = checkpointBlock(checkpoint, this.now().toISOString());
      return this.save(campaign, {
        status: "paused",
        pauseRequested: false,
        recipients: campaign.recipients.map((item) => item.recipientId === recipient!.recipientId
          ? { ...item, status: "paused", error: checkpointTechnicalError(checkpoint) }
          : item),
        blockReason: blocked.reason
      });
    }
    if (campaign.stopRequested) {
      return this.save(campaign, {
        status: "stopped",
        recipients: campaign.recipients.map((item) => item.recipientId === recipient!.recipientId
          ? { ...item, status: "stopped" }
          : item),
        stoppedAt: this.now().toISOString(),
        blockReason: null
      });
    }
    if (campaign.pauseRequested || checkpoint.pauseReason === "manual_pause") {
      return this.save(campaign, {
        status: "paused",
        recipients: campaign.recipients.map((item) => item.recipientId === recipient!.recipientId
          ? { ...item, status: "paused" }
          : item),
        blockReason: block("manual_pause", "La campaña quedó pausada en una frontera segura del contacto.", this.now().toISOString(), true)
      });
    }

    const failureClass = campaignContactFailureClass(checkpoint);
    if (failureClass === "local_safe") {
      return this.applySafeFailedCheckpoint(campaign, recipient, checkpoint);
    }
    if (failureClass === "partial_send") {
      return this.save(campaign, {
        status: "paused",
        pauseRequested: false,
        recipients: campaign.recipients.map((item) => item.recipientId === recipient!.recipientId
          ? { ...item, status: "paused", error: checkpointTechnicalError(checkpoint) }
          : item),
        blockReason: block(
          "contact_paused",
          "Parte del contenido ya fue confirmado para este contacto. Reintentar sólo puede continuar los pasos pendientes; nunca se repetirán los confirmados.",
          this.now().toISOString(),
          true,
          checkpointTechnicalError(checkpoint)
        )
      });
    }
    const blocked = checkpointBlock(checkpoint, this.now().toISOString());
    return this.save(campaign, {
      status: blocked.status,
      pauseRequested: blocked.reason.code === "whatsapp_ui_changed",
      recipients: campaign.recipients.map((item) => item.recipientId === recipient!.recipientId
        ? { ...item, status: blocked.recipientStatus, error: checkpointTechnicalError(checkpoint) }
        : item),
      blockReason: blocked.reason
    });
  }
}
