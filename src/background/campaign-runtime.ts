import { CampaignEngine } from "../campaign/campaign-engine";
import { CampaignEventPublisher } from "../campaign/events";
import { DailyLimitStore } from "../campaign/daily-limit";
import { CampaignStore, createCampaignState } from "../campaign/campaign-store";
import { progressForCampaign } from "../campaign/progress";
import { CampaignScheduler, ChromeCampaignWakeupScheduler } from "../campaign/scheduler";
import { toCampaignPublicStatus } from "../campaign/public-status";
import type {
  CampaignPublicStatus,
  CampaignRepository,
  CampaignState,
  DailyLimitRepository
} from "../campaign/campaign-types";
import { processContact } from "../engine/contact-engine";
import { markInterruptedCheckpointAmbiguous } from "../engine/steps";
import type { ContactProcessCheckpoint, ImageContactStep } from "../engine/types";
import type { ValidatedCampaign } from "../shared/campaign";
import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { base64ToArrayBuffer, type SerializedCampaignImage } from "../shared/serialization";
import type { WhatsAppPreflightResult } from "../shared/state";
import type { CampaignBlobStore } from "../storage/blob-store";
import type { ContactCheckpointStore } from "../storage/checkpoint-store";
import type { StateStore } from "../storage/state-store";
import { ChromeWhatsAppContactAdapter } from "./contact-adapter";
import type { WhatsAppTransport } from "./whatsapp-transport";
import type { CampaignWakeupScheduler } from "../campaign/scheduler";

const TERMINAL_CAMPAIGNS = new Set<CampaignState["status"]>(["completed", "stopped"]);

export interface CampaignRuntimeDependencies {
  stateStore: StateStore;
  blobStore: CampaignBlobStore;
  checkpointStore: ContactCheckpointStore;
  transport: WhatsAppTransport;
  runPreflight: (timeoutMs: number) => Promise<WhatsAppPreflightResult>;
  onContactCheckpoint: (checkpoint: ContactProcessCheckpoint) => Promise<void>;
  campaigns?: CampaignRepository;
  dailyLimit?: DailyLimitRepository;
  wakeups?: CampaignWakeupScheduler;
  now?: () => Date;
}

function statusMessage(campaign: CampaignState): string {
  const progress = progressForCampaign(campaign);
  if (campaign.status === "received") return "Campaña recibida. Ejecutá Iniciar cuando WhatsApp esté preparado.";
  if (campaign.status === "completed") return `Campaña completada: ${progress.completed}/${progress.total} contactos.`;
  if (campaign.status === "stopped") return "Campaña detenida por el usuario.";
  if (campaign.status === "daily_limit_reached") return "Límite diario alcanzado. No se iniciarán más contactos hoy.";
  if (campaign.status === "images_required") return "La campaña requiere volver a seleccionar imágenes temporales.";
  if (campaign.status === "waiting_batch") return "Tanda completada. Esperando la pausa configurada.";
  if (campaign.status === "waiting_contact") return "Esperando antes del siguiente contacto.";
  if (campaign.status === "pause_requested") return "Pausa solicitada; se aplicará en la próxima frontera segura.";
  if (campaign.status === "paused") return campaign.blockReason?.message ?? "Campaña pausada.";
  if (campaign.status === "error") return campaign.blockReason?.message ?? "La campaña se detuvo por un error.";
  return `Campaña en ejecución: ${progress.completed}/${progress.total} contactos completados.`;
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
  private readonly events = new CampaignEventPublisher();
  private readonly now: () => Date;

  constructor(private readonly dependencies: CampaignRuntimeDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.campaignStore = dependencies.campaigns ?? new CampaignStore();
    this.dailyLimit = dependencies.dailyLimit ?? new DailyLimitStore();
    this.engine = new CampaignEngine({
      campaigns: this.campaignStore,
      dailyLimit: this.dailyLimit,
      contactCheckpoints: dependencies.checkpointStore,
      contactRunner: {
        run: async (checkpoint, shouldPause) => {
          const state = await dependencies.stateStore.load();
          return processContact(checkpoint, {
            store: dependencies.checkpointStore,
            adapter: new ChromeWhatsAppContactAdapter(dependencies.blobStore, dependencies.transport),
            policy: state.config.retryPolicy,
            shouldPause,
            onCheckpoint: dependencies.onContactCheckpoint
          });
        }
      },
      now: this.now,
      onCampaign: async (campaign) => { await this.syncCampaign(campaign); }
    });
    this.scheduler = new CampaignScheduler({
      engine: this.engine,
      wakeups: dependencies.wakeups ?? new ChromeCampaignWakeupScheduler(),
      now: () => this.now().getTime(),
      onSettled: async (campaign) => {
        await this.syncCampaign(campaign);
        if (TERMINAL_CAMPAIGNS.has(campaign.status)) await dependencies.blobStore.deleteCampaign(campaign.campaignId);
      }
    });
  }

  async syncCampaign(campaign: CampaignState): Promise<CampaignPublicStatus> {
    const checkpoint = await this.dependencies.checkpointStore.loadActive();
    const publicStatus = toCampaignPublicStatus(campaign, checkpoint);
    const currentRecipient = campaign.activeContactId
      ? campaign.recipients.find((recipient) => recipient.recipientId === campaign.activeContactId) ?? null
      : campaign.currentRecipientIndex === null
        ? null
        : campaign.recipients[campaign.currentRecipientIndex] ?? null;
    const progress = progressForCampaign(campaign);
    const state = await this.dependencies.stateStore.load();
    const unavailable = ["whatsapp_reloading", "whatsapp_tab_closed", "whatsapp_session_closed"].includes(campaign.blockReason?.code ?? "");
    await this.dependencies.stateStore.save({
      ...state,
      status: extensionStatus(campaign),
      activeCampaign: campaign,
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
        total: progress.total,
        sent: progress.completed,
        failed: campaign.recipients.filter((recipient) => recipient.status === "error").length
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
      operational: unavailable ? false : state.operational,
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
    if (!["running", "pause_requested", "waiting_contact", "waiting_batch"].includes(current.status)) {
      throw new ExtensionError(ERROR_CODES.invalidInput, "La campaña no está en un estado que admita pausa.");
    }
    const campaign = await this.engine.requestPause(campaignId);
    if (campaign.status === "paused") await this.scheduler.cancel(campaignId);
    else await this.scheduler.schedule(campaign, true);
    return this.syncCampaign(campaign);
  }

  async resume(campaignId: string): Promise<CampaignPublicStatus> {
    const current = await this.campaignStore.loadActive();
    if (!current || current.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña solicitada no coincide con la activa.");
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

  async stop(campaignId: string): Promise<CampaignPublicStatus> {
    const campaign = await this.engine.requestStop(campaignId);
    if (campaign.status === "stopped") {
      await this.scheduler.cancel(campaignId);
      await this.dependencies.blobStore.deleteCampaign(campaignId);
    } else {
      await this.scheduler.schedule(campaign, true);
    }
    return this.syncCampaign(campaign);
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
    return toCampaignPublicStatus(campaign, checkpoint);
  }

  async handleAlarm(campaignId: string): Promise<CampaignState | null> {
    const campaign = await this.campaignStore.loadActive();
    if (!campaign || campaign.campaignId !== campaignId) return null;
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

  private async requireOperationalPreflight(campaignId: string): Promise<CampaignState> {
    const campaign = await this.campaignStore.loadActive();
    if (!campaign || campaign.campaignId !== campaignId) {
      throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña solicitada no coincide con la activa.");
    }
    const preflight = await this.dependencies.runPreflight(campaign.policy.whatsappLoadWaitMs);
    if (!preflight.operational) {
      throw new ExtensionError(
        preflight.qrDetected ? ERROR_CODES.sessionNotReady : preflight.pageDetected ? ERROR_CODES.interfaceLoading : ERROR_CODES.whatsappNotOpen,
        preflight.message
      );
    }
    return campaign;
  }
}
