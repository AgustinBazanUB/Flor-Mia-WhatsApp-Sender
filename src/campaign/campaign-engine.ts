import { createContactCheckpoint } from "../engine/steps";
import type { ContactCheckpointRepository, ContactProcessCheckpoint } from "../engine/types";
import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { assertCampaignTransition } from "./campaign-state-machine";
import type {
  CampaignBlockReason,
  CampaignRepository,
  CampaignState,
  DailyLimitRepository
} from "./campaign-types";
import { COMPATIBILITY_ERROR_CODES } from "../compatibility/diagnostic-error";
import { hasUnresolvedSendEvidence } from "../engine/checkpoint-safety";

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
  const currentStepError = checkpoint.steps.find((step) => step.id === checkpoint.currentStepId)?.error;
  const technicalError = checkpoint.error ?? currentStepError;
  if (checkpoint.status === "images_required") {
    return {
      status: "images_required",
      recipientStatus: "images_required",
      reason: block("images_required", "Faltan imágenes temporales para continuar la campaña.", at, true, technicalError)
    };
  }
  if (checkpoint.pauseReason === "verification_pending") {
    return {
      status: "paused",
      recipientStatus: "paused",
      reason: block("contact_ambiguous", "El resultado del contacto es ambiguo y debe reconciliarse antes de continuar.", at, true, technicalError)
    };
  }
  const code = technicalError?.code;
  if (code && COMPATIBILITY_ERROR_CODES.has(code)) {
    return {
      status: "paused",
      recipientStatus: "paused",
      reason: block(
        "whatsapp_ui_changed",
        "WhatsApp Web cambió y una capability crítica dejó de estar disponible.",
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
      reason: block("whatsapp_tab_closed", "La pestaña de WhatsApp Web no está disponible.", at, true, technicalError)
    };
  }
  if (code === ERROR_CODES.sessionNotReady) {
    return {
      status: "paused",
      recipientStatus: "paused",
      reason: block("whatsapp_session_closed", "La sesión de WhatsApp Web requiere intervención del usuario.", at, true, technicalError)
    };
  }
  if (code === ERROR_CODES.interfaceLoading || code === ERROR_CODES.timeout) {
    return {
      status: "paused",
      recipientStatus: "paused",
      reason: block("whatsapp_reloading", "WhatsApp Web se está cargando o dejó de responder temporalmente.", at, true, technicalError)
    };
  }
  if (checkpoint.status === "failed") {
    return {
      status: "error",
      recipientStatus: "error",
      reason: block("contact_failed", "El contacto se detuvo por un error no recuperable.", at, false, technicalError)
    };
  }
  return {
    status: "paused",
    recipientStatus: "paused",
    reason: block("contact_paused", "El ContactEngine pausó el destinatario actual.", at, true, technicalError)
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
      ? { ...item, status: "completed" as const, completedAt, error: undefined }
      : item);
    const allCompleted = recipients.every((item) => item.status === "completed");
    const completedInBatch = campaign.contactsCompletedInBatch + 1;
    const basePatch: Partial<CampaignState> = {
      recipients,
      dailyLimit: daily,
      lastCompletedContactId: recipient.recipientId,
      activeContactId: null,
      currentRecipientIndex: allCompleted ? null : recipient.position - 1,
      contactsCompletedInBatch: completedInBatch,
      blockReason: null
    };
    let terminalPatch: Partial<CampaignState>;
    if (allCompleted) {
      terminalPatch = { status: "completed", wait: null, completedAt };
    } else if (campaign.stopRequested) {
      terminalPatch = { status: "stopped", wait: null, stoppedAt: completedAt };
    } else if (campaign.pauseRequested) {
      terminalPatch = { status: "paused", wait: null };
    } else if (daily.remaining <= 0) {
      terminalPatch = {
        status: "daily_limit_reached",
        wait: null,
        blockReason: block("daily_limit_reached", "El contacto activo finalizó; el siguiente queda bloqueado por el límite diario.", completedAt, true)
      };
    } else {
      const batchBoundary = completedInBatch >= campaign.policy.contactsPerBatch;
      const delayMs = batchBoundary ? campaign.policy.delayBetweenBatchesMs : campaign.policy.delayBetweenContactsMs;
      const scheduledAt = this.now();
      terminalPatch = {
        status: batchBoundary ? "waiting_batch" : "waiting_contact",
        batchNumber: batchBoundary ? campaign.batchNumber + 1 : campaign.batchNumber,
        contactsCompletedInBatch: batchBoundary ? 0 : completedInBatch,
        wait: {
          kind: batchBoundary ? "between_batches" : "between_contacts",
          scheduledAt: scheduledAt.toISOString(),
          until: new Date(scheduledAt.getTime() + delayMs).toISOString()
        }
      };
    }
    await this.completionFault("before_campaign_save");
    const saved = await this.save(campaign, { ...basePatch, ...terminalPatch });
    await this.completionFault("after_campaign_save");
    await this.completionFault("before_checkpoint_clear");
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
      throw new ExtensionError(ERROR_CODES.campaignStopped, "La campaña tiene un error no recuperable y no puede reanudarse automáticamente.", { recoverable: false });
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
      const blocked = checkpointBlock(checkpoint, this.now().toISOString());
      if (checkpoint.status === "images_required" || checkpoint.status === "paused" || checkpoint.status === "failed") {
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
        "La campaña fue recuperada después de reiniciar el Service Worker. Ejecutá preflight y reanudá.",
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
                : "El health check detectó una capability crítica no resoluble."),
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
          ? { ...item, status: "active", startedAt: item.startedAt ?? startedAt, error: undefined }
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
          ? { ...item, status: "paused", error: checkpoint.error }
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
    const blocked = checkpointBlock(checkpoint, this.now().toISOString());
    return this.save(campaign, {
      status: blocked.status,
      pauseRequested: blocked.reason.code === "whatsapp_ui_changed",
      recipients: campaign.recipients.map((item) => item.recipientId === recipient!.recipientId
        ? { ...item, status: blocked.recipientStatus, error: checkpoint.error }
        : item),
      blockReason: blocked.reason
    });
  }
}
