import { CampaignEngine } from "../campaign/campaign-engine";
import { CampaignEventPublisher } from "../campaign/events";
import { CampaignHistoryStore } from "../campaign/history-store";
import { DailyLimitStore } from "../campaign/daily-limit";
import { CampaignStore, createCampaignState } from "../campaign/campaign-store";
import { campaignRecipientCounters } from "../campaign/progress";
import { CampaignScheduler, ChromeCampaignWakeupScheduler } from "../campaign/scheduler";
import { toCampaignPublicStatus } from "../campaign/public-status";
import type {
  CampaignBlockReason,
  CampaignHistoryRecord,
  CampaignHistoryRepository,
  CampaignPublicStatus,
  CampaignRepository,
  CampaignState,
  DailyLimitRepository
} from "../campaign/campaign-types";
import { processContact } from "../engine/contact-engine";
import { markInterruptedCheckpointAmbiguous } from "../engine/steps";
import type { ContactProcessCheckpoint, ImageContactStep } from "../engine/types";
import type { ContactCheckpointRepository } from "../engine/types";
import type { ValidatedCampaign } from "../shared/campaign";
import { ERROR_CODES, ExtensionError, serializeError } from "../shared/errors";
import { base64ToArrayBuffer, type SerializedCampaignImage } from "../shared/serialization";
import type { WhatsAppPreflightResult } from "../shared/state";
import type { CampaignBlobStore } from "../storage/blob-store";
import type { StateStore } from "../storage/state-store";
import { ChromeWhatsAppContactAdapter } from "./contact-adapter";
import type { WhatsAppTransport } from "./whatsapp-transport";
import type { CampaignWakeupScheduler } from "../campaign/scheduler";
import type {
  CampaignRequirements,
  CompatibilityDevelopmentFault,
  WhatsAppPreflightRequest
} from "../compatibility/types";
import { hasUnresolvedSendEvidence } from "../engine/checkpoint-safety";
import {
  clearCampaignControlIntent,
  hasCampaignControlIntent,
  registerActiveContactController,
  releaseActiveContactController
} from "./control-intent";

const TERMINAL_CAMPAIGNS = new Set<CampaignState["status"]>(["completed", "stopped"]);

type CampaignBlobRepository = Pick<CampaignBlobStore, "putCampaignImages" | "getImage" | "deleteCampaign">;

export interface CampaignRuntimeDependencies {
  stateStore: StateStore;
  blobStore: CampaignBlobRepository;
  checkpointStore: ContactCheckpointRepository;
  transport: WhatsAppTransport;
  runPreflight: (request: WhatsAppPreflightRequest) => Promise<WhatsAppPreflightResult>;
  onContactCheckpoint: (checkpoint: ContactProcessCheckpoint) => Promise<void>;
  campaigns?: CampaignRepository;
  dailyLimit?: DailyLimitRepository;
  wakeups?: CampaignWakeupScheduler;
  events?: CampaignEventPublisher;
  history?: CampaignHistoryRepository;
  extensionVersion?: string;
  includeRecipientNameInWebApp?: boolean;
  now?: () => Date;
}

function durationMs(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
}

function statusMessage(campaign: CampaignState): string {
  const counters = campaignRecipientCounters(campaign);
  if (campaign.status === "received") return "Campaña recibida. Ejecutá Iniciar cuando WhatsApp esté preparado.";
  if (campaign.status === "completed") {
    if (counters.unverifiedSent > 0) {
      return `Campaña completada · ${counters.confirmedSent} confirmados · ${counters.unverifiedSent} enviados sin confirmación · ${counters.failed} con problemas.`;
    }
    return counters.failed > 0
      ? `Campaña completada · ${counters.sent} enviados · ${counters.failed} con problemas.`
      : `Campaña completada con éxito: ${counters.sent}/${counters.total} enviados.`;
  }
  if (campaign.status === "stopped") return "Campaña detenida por el usuario. Podés quitarla del emisor cuando no haya un envío ambiguo pendiente.";
  if (campaign.status === "daily_limit_reached") return "Límite diario alcanzado. No se iniciarán más contactos hoy.";
  if (campaign.status === "images_required") return "La campaña requiere volver a seleccionar imágenes temporales.";
  if (campaign.status === "waiting_batch") return "Tanda completada. Esperando la pausa configurada.";
  if (campaign.status === "waiting_contact") return "Esperando antes del siguiente contacto.";
  if (campaign.status === "pause_requested") return "Pausando… se aplicará en la próxima frontera segura.";
  if (campaign.status === "paused") return campaign.blockReason?.message ?? "Campaña pausada.";
  if (campaign.status === "error") return campaign.blockReason?.message ?? "Necesita revisión. La campaña quedó detenida de forma segura.";
  return `Campaña en curso: ${counters.processed}/${counters.total} procesados · ${counters.sent} enviados.`;
}

function extensionStatus(campaign: CampaignState): "idle" | "ready" | "running" | "paused" | "error" | "completed" {
  if (campaign.status === "received") return "idle";
  if (campaign.status === "ready") return "ready";
  if (["running", "pause_requested", "waiting_contact", "waiting_batch"].includes(campaign.status)) return "running";
  if (["paused", "daily_limit_reached", "images_required"].includes(campaign.status)) return "paused";
  if (campaign.status === "error") return "error";
  if (campaign.status === "completed") return "completed";
  return "idle";
}

export class CampaignRuntime {
  readonly campaignStore: CampaignRepository;
  readonly dailyLimit: DailyLimitRepository;
  readonly engine: CampaignEngine;
  readonly scheduler: CampaignScheduler;
  private readonly events: CampaignEventPublisher;
  private readonly history: CampaignHistoryRepository;
  private readonly extensionVersion: string;
  private readonly now: () => Date;

  constructor(private readonly dependencies: CampaignRuntimeDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.events = dependencies.events ?? new CampaignEventPublisher();
    this.history = dependencies.history ?? new CampaignHistoryStore();
    this.extensionVersion = dependencies.extensionVersion ?? "development";
    this.campaignStore = dependencies.campaigns ?? new CampaignStore();
    this.dailyLimit = dependencies.dailyLimit ?? new DailyLimitStore();
    this.engine = new CampaignEngine({
      campaigns: this.campaignStore,
      dailyLimit: this.dailyLimit,
      contactCheckpoints: dependencies.checkpointStore,
      contactRunner: {
        run: async (checkpoint, shouldPause) => {
          const state = await dependencies.stateStore.load();
          const controller = new AbortController();
          registerActiveContactController(checkpoint.campaignId, controller);
          try {
            return await processContact(checkpoint, {
              store: dependencies.checkpointStore,
              adapter: new ChromeWhatsAppContactAdapter(dependencies.blobStore, dependencies.transport),
              policy: state.config.retryPolicy,
              signal: controller.signal,
              shouldPause: async () => hasCampaignControlIntent(checkpoint.campaignId) || await shouldPause(),
              onCheckpoint: dependencies.onContactCheckpoint
            });
          } finally {
            releaseActiveContactController(checkpoint.campaignId, controller);
          }
        }
      },
      healthCheck: async (campaign) => this.runLightweightHealthCheck(campaign),
      now: this.now,
      onCampaign: async (campaign) => { await this.syncCampaign(campaign); }
    });
    this.scheduler = new CampaignScheduler({
      engine: this.engine,
      wakeups: dependencies.wakeups ?? new ChromeCampaignWakeupScheduler(),
      now: () => this.now().getTime(),
      onSettled: async (campaign) => {
        await this.syncCampaign(campaign);
      }
    });
  }

  private async finalizeTerminalCampaign(
    campaign: CampaignState,
    checkpoint: ContactProcessCheckpoint | null
  ): Promise<void> {
    if (campaign.status !== "completed" && campaign.status !== "stopped") return;
    const matchingCheckpoint = checkpoint?.campaignId === campaign.campaignId ? checkpoint : null;
    if (hasUnresolvedSendEvidence(matchingCheckpoint)) {
      throw new ExtensionError(ERROR_CODES.internal, "La campaña terminal conserva un envío ambiguo pendiente de reconciliación.", { recoverable: false });
    }
    const counters = campaignRecipientCounters(campaign);
    if (campaign.status === "completed") {
      const allRecipientsTerminal = campaign.recipients.length > 0
        && campaign.recipients.every((recipient) => recipient.status === "completed" || recipient.status === "error")
        && counters.processed === campaign.recipients.length;
      if (!allRecipientsTerminal || campaign.activeContactId !== null || !campaign.completedAt) {
        throw new ExtensionError(ERROR_CODES.internal, "La campaña no puede finalizar porque conserva destinatarios pendientes o activos.", { recoverable: false });
      }
      if (matchingCheckpoint && matchingCheckpoint.status !== "completed") {
        throw new ExtensionError(ERROR_CODES.internal, "La campaña completada conserva un checkpoint de contacto incompleto.", { recoverable: false });
      }
      if (matchingCheckpoint) await this.dependencies.checkpointStore.clearActive();
    }

    const completedAt = campaign.completedAt ?? campaign.stoppedAt;
    if (!completedAt) {
      throw new ExtensionError(ERROR_CODES.internal, "La campaña terminal no tiene timestamp de finalización.", { recoverable: false });
    }
    const dailyCounterImpact = campaign.dailyLimit.countedContactKeys
      .filter((key) => key.startsWith(`${campaign.campaignId}:`)).length;
    const record: CampaignHistoryRecord = {
      historySchemaVersion: 1,
      campaignId: campaign.campaignId,
      campaignName: campaign.campaignName,
      startedAt: campaign.startedAt ?? null,
      completedAt,
      total: campaign.recipients.length,
      completed: counters.sent,
      failed: counters.failed,
      processed: counters.processed,
      confirmedSent: counters.confirmedSent,
      unverifiedSent: counters.unverifiedSent,
      retryCycle: campaign.retryCycle ?? 0,
      status: campaign.status,
      errorCategory: campaign.status === "stopped" ? "USER_STOP" : null,
      extensionVersion: this.extensionVersion,
      dailyCounterImpact,
      durationMs: durationMs(campaign.startedAt ?? campaign.createdAt, completedAt),
      batches: campaign.batchNumber,
      recordedAt: this.now().toISOString()
    };
    await this.history.upsert(record);

    if (campaign.status === "completed" && counters.failed === 0) {
      await this.dependencies.blobStore.deleteCampaign(campaign.campaignId);
    }
  }

  async syncCampaign(campaign: CampaignState): Promise<CampaignPublicStatus> {
    const checkpoint = await this.dependencies.checkpointStore.loadActive();
    const currentRecipient = campaign.activeContactId
      ? campaign.recipients.find((recipient) => recipient.recipientId === campaign.activeContactId) ?? null
      : campaign.currentRecipientIndex === null
        ? null
        : campaign.recipients[campaign.currentRecipientIndex] ?? null;
    const counters = campaignRecipientCounters(campaign);
    const state = await this.dependencies.stateStore.load();
    await this.finalizeTerminalCampaign(campaign, checkpoint);
    const publicStatus = toCampaignPublicStatus(campaign, checkpoint, {
      extensionVersion: this.extensionVersion,
      redGreen: state.compatibility.overallStatus,
      includeRecipientName: this.dependencies.includeRecipientNameInWebApp ?? false
    });
    const unavailable = ["whatsapp_reloading", "whatsapp_tab_closed", "whatsapp_session_closed"].includes(campaign.blockReason?.code ?? "");
    const completedOperational = campaign.status === "completed"
      ? Boolean(state.whatsapp?.operational && state.compatibility.overallStatus === "GREEN")
      : state.operational;
    await this.dependencies.stateStore.save({
      ...state,
      status: extensionStatus(campaign),
      activeCampaign: publicStatus,
      dailyLimit: campaign.dailyLimit,
      currentCampaign: {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        createdBy: campaign.createdBy,
        totalRecipients: campaign.recipients.length,
        messageLength: campaign.text.length,
        imageCount: campaign.images.length,
        receivedAt: campaign.receivedAt,
        status: campaign.status
      },
      progress: {
        total: counters.total,
        sent: counters.sent,
        failed: counters.failed
      },
      currentContact: currentRecipient ? {
        recipientId: currentRecipient.recipientId,
        name: currentRecipient.name,
        phone: `+${currentRecipient.phoneDigits}`,
        maskedPhone: currentRecipient.maskedPhone
      } : null,
      currentStep: checkpoint?.campaignId === campaign.campaignId
        ? checkpoint.currentStepId
        : campaign.wait?.kind ?? null,
      activeContactProcess: checkpoint?.campaignId === campaign.campaignId ? checkpoint : null,
      operational: unavailable ? false : completedOperational,
      statusMessage: statusMessage(campaign)
    });
    await this.events.publish(publicStatus);
    return publicStatus;
  }

  async initialize(): Promise<CampaignState | null> {
    let campaign = await this.campaignStore.loadActive();
    if (!campaign) return null;
    const daily = await this.dailyLimit.load(campaign.policy.dailyContactLimit, this.now());
    if (daily.localDate !== campaign.dailyLimit.localDate || daily.completedToday !== campaign.dailyLimit.completedToday) {
      campaign = await this.campaignStore.saveActive({
        ...campaign,
        dailyLimit: daily,
        sequence: campaign.sequence + 1,
        updatedAt: this.now().toISOString()
      });
    }
    let checkpoint = await this.dependencies.checkpointStore.loadActive();
    if (checkpoint?.campaignId === campaign.campaignId) {
      checkpoint = markInterruptedCheckpointAmbiguous(checkpoint, this.now().toISOString());
      await this.dependencies.checkpointStore.saveActive(checkpoint);
    }
    campaign = await this.engine.recoverAfterServiceWorkerRestart(campaign, checkpoint);
    await this.syncCampaign(campaign);
    if (campaign.status === "waiting_batch" || campaign.status === "waiting_contact") await this.scheduler.schedule(campaign);
    return campaign;
  }

  async prepare(campaign: ValidatedCampaign): Promise<CampaignState> {
    const existing = await this.campaignStore.loadActive();
    if (existing && !TERMINAL_CAMPAIGNS.has(existing.status)) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "Ya existe una campaña activa. Detenela o completala antes de recibir otra.");
    }
    const contactCheckpoint = await this.dependencies.checkpointStore.loadActive();
    const belongsToFinishedCampaign = Boolean(existing
      && TERMINAL_CAMPAIGNS.has(existing.status)
      && contactCheckpoint?.campaignId === existing.campaignId);
    if (contactCheckpoint && !belongsToFinishedCampaign && !["completed", "failed"].includes(contactCheckpoint.status)) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "Existe un contacto manual activo. Finalizalo antes de preparar una campaña.");
    }
    if (existing) await this.dependencies.blobStore.deleteCampaign(existing.campaignId);
    if (contactCheckpoint) await this.dependencies.checkpointStore.clearActive();
    await this.dependencies.blobStore.deleteCampaign(campaign.campaignId);
    await this.dependencies.blobStore.putCampaignImages(campaign.campaignId, campaign.images.map((image) => ({
      imageId: `image-${image.order}`,
      order: image.order,
      name: image.name,
      type: image.type,
      blob: new Blob([image.data], { type: image.type })
    })));
    const state = await this.dependencies.stateStore.load();
    const daily = await this.dailyLimit.load(state.config.campaignPolicy.dailyContactLimit, this.now());
    const next = createCampaignState(campaign, state.config.campaignPolicy, daily, this.now().toISOString());
    await this.campaignStore.saveActive(next);
    await this.syncCampaign(next);
    return next;
  }

  async start(campaignId: string): Promise<CampaignPublicStatus> {
    clearCampaignControlIntent(campaignId);
    const current = await this.campaignStore.loadActive();
    if (!current || current.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña solicitada no coincide con la activa.");
    }
    if (!["received", "ready"].includes(current.status)) {
      throw new ExtensionError(ERROR_CODES.invalidInput, "Iniciar solo está disponible para una campaña recibida y preparada.");
    }
    const campaign = await this.requireOperationalPreflight(campaignId);
    const started = await this.engine.start(campaign.campaignId);
    await this.scheduler.schedule(started, true);
    return this.syncCampaign(started);
  }

  async pause(campaignId: string): Promise<CampaignPublicStatus> {
    const current = await this.campaignStore.loadActive();
    if (!current || current.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña solicitada no coincide con la activa.");
    }
    if (current.status === "paused") {
      clearCampaignControlIntent(campaignId);
      return this.syncCampaign(current);
    }
    if (!["running", "pause_requested", "waiting_contact", "waiting_batch"].includes(current.status)) {
      throw new ExtensionError(ERROR_CODES.invalidInput, "La campaña no está en un estado que admita pausa.");
    }
    const campaign = await this.engine.requestPause(campaignId);
    if (campaign.status === "paused") await this.scheduler.cancel(campaign);
    else await this.scheduler.schedule(campaign, true);
    clearCampaignControlIntent(campaignId);
    return this.syncCampaign(campaign);
  }

  async resume(campaignId: string): Promise<CampaignPublicStatus> {
    clearCampaignControlIntent(campaignId);
    const current = await this.campaignStore.loadActive();
    if (!current || current.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña solicitada no coincide con la activa.");
    }
    if (["running", "pause_requested", "waiting_contact", "waiting_batch"].includes(current.status)) {
      return this.syncCampaign(current);
    }

    const counters = campaignRecipientCounters(current);
    if (current.status === "completed" && counters.failed > 0) {
      await this.requireOperationalPreflight(campaignId);
      const retried = await this.engine.retryFailed(campaignId);
      await this.scheduler.schedule(retried, retried.status === "running");
      return this.syncCampaign(retried);
    }
    if (current.status === "error" || (
      current.status === "paused"
      && ["repeated_contact_failures", "contact_failed", "contact_paused", "service_worker_restarted"].includes(current.blockReason?.code ?? "")
    )) {
      await this.requireOperationalPreflight(campaignId);
      const retried = await this.engine.retry(campaignId);
      await this.scheduler.schedule(retried, true);
      return this.syncCampaign(retried);
    }

    if (!["paused", "daily_limit_reached", "images_required"].includes(current.status)) {
      throw new ExtensionError(ERROR_CODES.invalidInput, "La campaña no está en un estado que admita reanudación.");
    }
    if (current.status === "images_required") {
      throw new ExtensionError(ERROR_CODES.imageMissing, "Volvé a seleccionar las imágenes antes de reanudar.");
    }
    await this.requireOperationalPreflight(campaignId);
    const resumed = await this.engine.resume(campaignId);
    await this.scheduler.schedule(resumed, !resumed.wait);
    return this.syncCampaign(resumed);
  }

  async retry(campaignId: string): Promise<CampaignPublicStatus> {
    clearCampaignControlIntent(campaignId);
    await this.requireOperationalPreflight(campaignId);
    const retried = await this.engine.retry(campaignId);
    await this.scheduler.schedule(retried, true);
    return this.syncCampaign(retried);
  }

  async retryFailed(campaignId: string): Promise<CampaignPublicStatus> {
    clearCampaignControlIntent(campaignId);
    await this.requireOperationalPreflight(campaignId);
    const retried = await this.engine.retryFailed(campaignId);
    await this.scheduler.schedule(retried, retried.status === "running");
    return this.syncCampaign(retried);
  }

  async stop(campaignId: string): Promise<CampaignPublicStatus> {
    const current = await this.campaignStore.loadActive();
    if (!current || current.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña solicitada no coincide con la activa.");
    }
    if (current.status === "stopped") {
      const snapshot = await this.syncCampaign(current);
      await this.release(campaignId);
      return snapshot;
    }
    const campaign = await this.engine.requestStop(campaignId);
    if (campaign.status === "stopped") {
      await this.scheduler.cancel(campaign);
    } else {
      await this.scheduler.schedule(campaign, true);
    }
    clearCampaignControlIntent(campaignId);
    return this.syncCampaign(campaign);
  }

  async release(campaignId: string): Promise<{ campaignId: string; releasedAt: string }> {
    const campaign = await this.campaignStore.loadActive();
    if (!campaign || campaign.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña solicitada no coincide con la activa.");
    }
    if (campaign.status !== "stopped") {
      throw new ExtensionError(ERROR_CODES.invalidInput, "Sólo una campaña detenida puede quitarse del emisor activo.");
    }
    const checkpoint = await this.dependencies.checkpointStore.loadActive();
    if (checkpoint?.campaignId === campaignId && hasUnresolvedSendEvidence(checkpoint)) {
      throw new ExtensionError(ERROR_CODES.ambiguousResult, "No se puede borrar la campaña activa mientras exista un envío ambiguo pendiente.");
    }
    await this.scheduler.cancel(campaign);
    if (checkpoint?.campaignId === campaignId) await this.dependencies.checkpointStore.clearActive();
    await this.dependencies.blobStore.deleteCampaign(campaignId);
    clearCampaignControlIntent(campaignId);
    await this.campaignStore.clearActive();
    await this.dependencies.stateStore.patch({
      status: "idle",
      activeCampaign: null,
      currentCampaign: null,
      progress: { total: 0, sent: 0, failed: 0 },
      currentContact: null,
      currentStep: null,
      activeContactProcess: null,
      statusMessage: "Emisor libre. Podés preparar una nueva campaña."
    });
    return { campaignId, releasedAt: this.now().toISOString() };
  }

  async getStatus(campaignId?: string): Promise<CampaignPublicStatus | null> {
    let campaign = await this.campaignStore.loadActive();
    if (!campaign) return null;
    if (campaignId && campaign.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña consultada no coincide con la activa.");
    }
    const daily = await this.dailyLimit.load(campaign.policy.dailyContactLimit, this.now());
    if (
      campaign.dailyLimit.localDate !== daily.localDate
      || campaign.dailyLimit.completedToday !== daily.completedToday
      || campaign.dailyLimit.limit !== daily.limit
    ) {
      campaign = await this.campaignStore.saveActive({
        ...campaign,
        dailyLimit: daily,
        sequence: campaign.sequence + 1,
        updatedAt: this.now().toISOString()
      });
      await this.syncCampaign(campaign);
    }
    const checkpoint = await this.dependencies.checkpointStore.loadActive();
    const state = await this.dependencies.stateStore.load();
    return toCampaignPublicStatus(campaign, checkpoint, {
      extensionVersion: this.extensionVersion,
      redGreen: state.compatibility.overallStatus,
      includeRecipientName: this.dependencies.includeRecipientNameInWebApp ?? false
    });
  }

  async handleAlarm(campaignId: string, runToken: string): Promise<CampaignState | null> {
    const campaign = await this.campaignStore.loadActive();
    if (!campaign || campaign.campaignId !== campaignId || campaign.runToken !== runToken) return null;
    return this.scheduler.run(campaignId);
  }

  async restoreImages(campaignId: string, images: SerializedCampaignImage[]): Promise<CampaignPublicStatus> {
    const campaign = await this.campaignStore.loadActive();
    const checkpoint = await this.dependencies.checkpointStore.loadActive();
    if (!campaign || campaign.campaignId !== campaignId || !checkpoint || checkpoint.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña activa no coincide con las imágenes seleccionadas.");
    }
    const missing = checkpoint.steps.filter((step): step is ImageContactStep => step.kind === "image" && step.status === "images_required");
    const requiredOrders = new Set(missing.map((step) => step.image.order));
    const receivedOrders = new Set(images.map((image) => image.order));
    if (missing.length === 0 || [...requiredOrders].some((order) => !receivedOrders.has(order))) {
      throw new ExtensionError(ERROR_CODES.invalidInput, "Seleccioná cada imagen que figura como faltante.");
    }
    const restored = images.map((image) => {
      const asset = campaign.images.find((candidate) => candidate.order === image.order);
      if (!asset) throw new ExtensionError(ERROR_CODES.invalidInput, `La imagen ${image.order} no pertenece a la campaña.`);
      const data = base64ToArrayBuffer(image.dataBase64);
      if (asset.name !== image.name || asset.type !== image.type || asset.size !== image.size || data.byteLength !== asset.size) {
        throw new ExtensionError(ERROR_CODES.invalidInput, `La imagen ${image.order} no coincide con el archivo original.`);
      }
      return { imageId: asset.imageId, order: asset.order, name: asset.name, type: asset.type, blob: new Blob([data], { type: asset.type }) };
    });
    await this.dependencies.blobStore.putCampaignImages(campaignId, restored);
    const nextCheckpoint: ContactProcessCheckpoint = {
      ...checkpoint,
      status: "paused",
      pauseReason: undefined,
      error: undefined,
      steps: checkpoint.steps.map((step) => step.kind === "image" && step.status === "images_required" && receivedOrders.has(step.image.order)
        ? { ...step, status: "pending", error: undefined }
        : step),
      updatedAt: this.now().toISOString()
    };
    await this.dependencies.checkpointStore.saveActive(nextCheckpoint);
    const nextCampaign = await this.engine.markImagesRestored(campaignId);
    await this.dependencies.onContactCheckpoint(nextCheckpoint);
    return this.syncCampaign(nextCampaign);
  }

  async runCampaignPreflight(
    campaignId: string,
    developmentFault: CompatibilityDevelopmentFault = "none"
  ): Promise<WhatsAppPreflightResult> {
    const campaign = await this.campaignStore.loadActive();
    if (!campaign || campaign.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña solicitada no coincide con la activa.");
    }
    return this.dependencies.runPreflight({
      timeoutMs: Math.min(campaign.policy.whatsappLoadWaitMs, 5_000),
      level: "full",
      purpose: "campaign_start",
      requirements: this.requirementsFor(campaign),
      developmentFault
    });
  }

  private async requireOperationalPreflight(campaignId: string): Promise<CampaignState> {
    const campaign = await this.campaignStore.loadActive();
    if (!campaign || campaign.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña solicitada no coincide con la activa.");
    }
    const preflight = await this.runCampaignPreflight(campaignId);
    if (!preflight.operational) {
      throw this.preflightError(preflight);
    }
    return campaign;
  }

  private requirementsFor(campaign: CampaignState): CampaignRequirements {
    return {
      needsText: Boolean(campaign.text.trim()),
      needsImages: campaign.images.length > 0
    };
  }

  private preflightError(preflight: WhatsAppPreflightResult): ExtensionError {
    const failure = preflight.failures[0];
    const code = preflight.qrDetected
      ? ERROR_CODES.sessionNotReady
      : !preflight.pageDetected
        ? ERROR_CODES.whatsappNotOpen
        : preflight.status === "loading"
          ? ERROR_CODES.interfaceLoading
          : ERROR_CODES.preflightFailed;
    return new ExtensionError(code, preflight.message, {
      recoverable: true,
      ...(failure ? { details: { compatibilityDiagnostic: failure, failedCapability: failure.capability } } : {})
    });
  }

  private async runLightweightHealthCheck(campaign: CampaignState): Promise<{
    healthy: boolean;
    temporary?: boolean;
    blockCode?: CampaignBlockReason["code"];
    error?: ReturnType<typeof serializeError>;
    message?: string;
  }> {
    const preflight = await this.dependencies.runPreflight({
      timeoutMs: Math.min(campaign.policy.whatsappLoadWaitMs, 1_500),
      level: "lightweight",
      purpose: "health_check",
      requirements: { needsText: false, needsImages: false }
    });
    if (preflight.operational) return { healthy: true };
    const error = this.preflightError(preflight);
    const blockCode = error.code === ERROR_CODES.whatsappNotOpen
      ? "whatsapp_tab_closed"
      : error.code === ERROR_CODES.sessionNotReady
        ? "whatsapp_session_closed"
        : error.code === ERROR_CODES.interfaceLoading
          ? "whatsapp_reloading"
          : "whatsapp_ui_changed";
    return {
      healthy: false,
      temporary: ["loading", "unavailable", "login_required"].includes(preflight.status),
      blockCode,
      error: serializeError(error),
      message: preflight.message
    };
  }
}
