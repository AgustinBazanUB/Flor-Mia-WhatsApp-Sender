import type { ValidatedCampaign } from "../shared/campaign";
import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { createId } from "../shared/ids";
import { CampaignDataStore, type CampaignColdRepository } from "../storage/campaign-data-store";
import { ChromeLocalStorageAdapter, type KeyValueStorage } from "../storage/state-store";
import { LOCAL_FAILURE_CIRCUIT_THRESHOLD } from "./failure-policy";
import type { CampaignPolicyConfig, CampaignRecipientState, CampaignRepository, CampaignState, DailyLimitState } from "./campaign-types";

export const ACTIVE_CAMPAIGN_KEY = "activeCampaign";

interface CampaignHotState {
  storageSchemaVersion: 2;
  schemaVersion: 1;
  runToken?: string;
  retryCycle?: number;
  campaignId: string;
  status: CampaignState["status"];
  currentRecipientIndex: number | null;
  activeContactId: string | null;
  lastCompletedContactId: string | null;
  completedRecipients: number;
  batchNumber: number;
  contactsCompletedInBatch: number;
  pauseRequested: boolean;
  stopRequested: boolean;
  cancelRequested?: boolean;
  wait: CampaignState["wait"];
  blockReason: CampaignState["blockReason"];
  failureCircuit?: CampaignState["failureCircuit"];
  dailyLimit: DailyLimitState;
  sequence: number;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  stoppedAt?: string;
  cancelledAt?: string;
}

function isLegacyCampaignState(value: unknown): value is CampaignState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CampaignState>;
  return candidate.schemaVersion === 1
    && typeof candidate.campaignId === "string"
    && Array.isArray(candidate.recipients)
    && Array.isArray(candidate.images)
    && typeof candidate.status === "string";
}

function isHotState(value: unknown): value is CampaignHotState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CampaignHotState>;
  return candidate.storageSchemaVersion === 2
    && candidate.schemaVersion === 1
    && typeof candidate.campaignId === "string"
    && typeof candidate.status === "string"
    && Number.isInteger(candidate.sequence);
}

function normalizeCampaign(campaign: CampaignState): CampaignState {
  const now = new Date().toISOString();
  return {
    ...campaign,
    runToken: campaign.runToken ?? createId("campaign-run"),
    retryCycle: campaign.retryCycle ?? 0,
    cancelRequested: campaign.cancelRequested ?? false,
    failureCircuit: campaign.failureCircuit ?? {
      signature: null,
      consecutive: 0,
      threshold: LOCAL_FAILURE_CIRCUIT_THRESHOLD,
      updatedAt: now
    }
  };
}

function toHotState(campaign: CampaignState): CampaignHotState {
  return {
    storageSchemaVersion: 2,
    schemaVersion: 1,
    runToken: campaign.runToken,
    retryCycle: campaign.retryCycle,
    campaignId: campaign.campaignId,
    status: campaign.status,
    currentRecipientIndex: campaign.currentRecipientIndex,
    activeContactId: campaign.activeContactId,
    lastCompletedContactId: campaign.lastCompletedContactId,
    completedRecipients: campaign.completedRecipients,
    batchNumber: campaign.batchNumber,
    contactsCompletedInBatch: campaign.contactsCompletedInBatch,
    pauseRequested: campaign.pauseRequested,
    stopRequested: campaign.stopRequested,
    cancelRequested: campaign.cancelRequested,
    wait: campaign.wait,
    blockReason: campaign.blockReason,
    failureCircuit: campaign.failureCircuit,
    dailyLimit: campaign.dailyLimit,
    sequence: campaign.sequence,
    updatedAt: campaign.updatedAt,
    ...(campaign.startedAt ? { startedAt: campaign.startedAt } : {}),
    ...(campaign.completedAt ? { completedAt: campaign.completedAt } : {}),
    ...(campaign.stoppedAt ? { stoppedAt: campaign.stoppedAt } : {}),
    ...(campaign.cancelledAt ? { cancelledAt: campaign.cancelledAt } : {})
  };
}

function recipientMutationSignature(recipient: CampaignRecipientState): string {
  return JSON.stringify({
    status: recipient.status,
    startedAt: recipient.startedAt ?? null,
    completedAt: recipient.completedAt ?? null,
    deliveryConfidence: recipient.deliveryConfidence ?? null,
    error: recipient.error ?? null,
    failure: recipient.failure ?? null
  });
}

export function createCampaignState(
  campaign: ValidatedCampaign,
  policy: CampaignPolicyConfig,
  dailyLimit: DailyLimitState,
  now = new Date().toISOString()
): CampaignState {
  return {
    schemaVersion: 1,
    runToken: createId("campaign-run"),
    retryCycle: 0,
    campaignId: campaign.campaignId,
    campaignName: campaign.campaignName,
    createdBy: campaign.createdBy,
    status: "received",
    recipients: campaign.recipients.map((recipient, index) => ({
      recipientId: recipient.recipientId,
      clientId: recipient.clientId,
      name: recipient.name,
      phoneDigits: recipient.phoneDigits,
      maskedPhone: recipient.maskedPhone,
      source: recipient.source,
      position: index + 1,
      status: "pending"
    })),
    text: campaign.message,
    images: campaign.images.map((image) => ({
      imageId: `image-${image.order}`,
      order: image.order,
      name: image.name,
      type: image.type,
      size: image.size
    })),
    currentRecipientIndex: null,
    activeContactId: null,
    lastCompletedContactId: null,
    completedRecipients: 0,
    batchNumber: 1,
    contactsCompletedInBatch: 0,
    pauseRequested: false,
    stopRequested: false,
    cancelRequested: false,
    wait: null,
    blockReason: null,
    failureCircuit: {
      signature: null,
      consecutive: 0,
      threshold: LOCAL_FAILURE_CIRCUIT_THRESHOLD,
      updatedAt: now
    },
    policy,
    dailyLimit,
    sequence: 1,
    receivedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

export class CampaignStore implements CampaignRepository {
  private cache: CampaignState | null | undefined;
  private recipientSignatures = new Map<string, string>();

  constructor(
    private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter(),
    private readonly cold: CampaignColdRepository = new CampaignDataStore()
  ) {}

  private remember(campaign: CampaignState | null): CampaignState | null {
    this.cache = campaign;
    this.recipientSignatures.clear();
    for (const recipient of campaign?.recipients ?? []) {
      this.recipientSignatures.set(recipient.recipientId, recipientMutationSignature(recipient));
    }
    return campaign;
  }

  async loadActive(): Promise<CampaignState | null> {
    if (this.cache !== undefined) return this.cache;
    const result = await this.storage.get(ACTIVE_CAMPAIGN_KEY);
    const stored = result[ACTIVE_CAMPAIGN_KEY];
    if (stored === null || stored === undefined) return this.remember(null);

    if (isLegacyCampaignState(stored)) {
      const migrated = normalizeCampaign(stored);
      await this.cold.replaceCampaign(migrated);
      await this.storage.set({ [ACTIVE_CAMPAIGN_KEY]: toHotState(migrated) });
      return this.remember(migrated);
    }

    if (!isHotState(stored)) {
      throw new ExtensionError(ERROR_CODES.storageError, "La campaña persistida no tiene un formato válido.", { recoverable: false });
    }
    const cold = await this.cold.loadCampaign(stored.campaignId);
    if (!cold) {
      throw new ExtensionError(ERROR_CODES.storageError, "Faltan los datos fríos de la campaña activa.", { recoverable: false });
    }
    const campaign = normalizeCampaign({
      ...stored,
      campaignName: cold.payload.campaignName,
      createdBy: cold.payload.createdBy,
      recipients: cold.recipients,
      text: cold.payload.text,
      images: cold.payload.images,
      policy: cold.payload.policy,
      receivedAt: cold.payload.receivedAt,
      createdAt: cold.payload.createdAt
    } as CampaignState);
    return this.remember(campaign);
  }

  async saveActive(input: CampaignState): Promise<CampaignState> {
    if (!isLegacyCampaignState(input)) {
      throw new ExtensionError(ERROR_CODES.storageError, "No se puede guardar una campaña inválida.", { recoverable: false });
    }
    const campaign = normalizeCampaign(input);
    const previous = await this.loadActive();
    if (!previous || previous.campaignId !== campaign.campaignId) {
      if (previous) await this.cold.deleteCampaign(previous.campaignId);
      await this.cold.replaceCampaign(campaign);
      this.recipientSignatures.clear();
      for (const recipient of campaign.recipients) {
        this.recipientSignatures.set(recipient.recipientId, recipientMutationSignature(recipient));
      }
    } else {
      const changed: CampaignRecipientState[] = [];
      for (const recipient of campaign.recipients) {
        const signature = recipientMutationSignature(recipient);
        if (this.recipientSignatures.get(recipient.recipientId) !== signature) {
          changed.push(recipient);
          this.recipientSignatures.set(recipient.recipientId, signature);
        }
      }
      if (changed.length) await this.cold.putRecipients(campaign.campaignId, changed);
    }
    await this.storage.set({ [ACTIVE_CAMPAIGN_KEY]: toHotState(campaign) });
    this.cache = campaign;
    return campaign;
  }

  async clearActive(): Promise<void> {
    const current = await this.loadActive();
    await this.storage.set({ [ACTIVE_CAMPAIGN_KEY]: null });
    if (current) await this.cold.deleteCampaign(current.campaignId);
    this.remember(null);
  }
}
