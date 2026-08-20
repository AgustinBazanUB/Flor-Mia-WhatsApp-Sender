import type { CampaignImageAsset, CampaignPolicyConfig, CampaignRecipientState, CampaignState } from "../campaign/campaign-types";
import {
  CAMPAIGN_PAYLOAD_STORE,
  CAMPAIGN_RECIPIENT_STORE,
  openFlorMiaDatabase,
  recordIndexedDbWrite,
  requestResult
} from "./database";

export interface CampaignColdPayload {
  campaignId: string;
  campaignName: string;
  createdBy: string;
  text: string;
  images: CampaignImageAsset[];
  policy: CampaignPolicyConfig;
  receivedAt: string;
  createdAt: string;
}

interface StoredRecipient extends CampaignRecipientState {
  key: string;
  campaignId: string;
}

export interface CampaignColdSnapshot {
  payload: CampaignColdPayload;
  recipients: CampaignRecipientState[];
}

export interface CampaignColdRepository {
  loadCampaign(campaignId: string): Promise<CampaignColdSnapshot | null>;
  replaceCampaign(campaign: CampaignState): Promise<void>;
  putRecipients(campaignId: string, recipients: CampaignRecipientState[]): Promise<void>;
  deleteCampaign(campaignId: string): Promise<void>;
}

function coldPayload(campaign: CampaignState): CampaignColdPayload {
  return {
    campaignId: campaign.campaignId,
    campaignName: campaign.campaignName,
    createdBy: campaign.createdBy,
    text: campaign.text,
    images: campaign.images.map((image) => ({ ...image })),
    policy: { ...campaign.policy },
    receivedAt: campaign.receivedAt,
    createdAt: campaign.createdAt
  };
}

function storedRecipient(campaignId: string, recipient: CampaignRecipientState): StoredRecipient {
  return { ...recipient, key: `${campaignId}:${recipient.recipientId}`, campaignId };
}

export class CampaignDataStore implements CampaignColdRepository {
  constructor(private readonly indexedDb: IDBFactory = globalThis.indexedDB) {}

  async loadCampaign(campaignId: string): Promise<CampaignColdSnapshot | null> {
    const database = await openFlorMiaDatabase(this.indexedDb);
    try {
      const transaction = database.transaction([CAMPAIGN_PAYLOAD_STORE, CAMPAIGN_RECIPIENT_STORE], "readonly");
      const payload = await requestResult(transaction.objectStore(CAMPAIGN_PAYLOAD_STORE).get(campaignId)) as CampaignColdPayload | undefined;
      if (!payload) return null;
      const index = transaction.objectStore(CAMPAIGN_RECIPIENT_STORE).index("campaignId");
      const records = await requestResult(index.getAll(IDBKeyRange.only(campaignId))) as StoredRecipient[];
      const recipients = records
        .sort((a, b) => a.position - b.position)
        .map((record) => {
          const recipient = { ...record };
          delete (recipient as Partial<StoredRecipient>).key;
          delete (recipient as Partial<StoredRecipient>).campaignId;
          return recipient as CampaignRecipientState;
        });
      return { payload, recipients };
    } finally {
      database.close();
    }
  }

  async replaceCampaign(campaign: CampaignState): Promise<void> {
    const database = await openFlorMiaDatabase(this.indexedDb);
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([CAMPAIGN_PAYLOAD_STORE, CAMPAIGN_RECIPIENT_STORE], "readwrite");
        transaction.objectStore(CAMPAIGN_PAYLOAD_STORE).put(coldPayload(campaign));
        const recipients = transaction.objectStore(CAMPAIGN_RECIPIENT_STORE);
        const index = recipients.index("campaignId");
        const cursorRequest = index.openKeyCursor(IDBKeyRange.only(campaign.campaignId));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            for (const recipient of campaign.recipients) recipients.put(storedRecipient(campaign.campaignId, recipient));
            return;
          }
          recipients.delete(cursor.primaryKey);
          cursor.continue();
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar la campaña fría."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Se canceló el guardado de campaña."));
      });
      recordIndexedDbWrite({ payload: coldPayload(campaign), recipients: campaign.recipients });
    } finally {
      database.close();
    }
  }

  async putRecipients(campaignId: string, recipients: CampaignRecipientState[]): Promise<void> {
    if (recipients.length === 0) return;
    const database = await openFlorMiaDatabase(this.indexedDb);
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(CAMPAIGN_RECIPIENT_STORE, "readwrite");
        const store = transaction.objectStore(CAMPAIGN_RECIPIENT_STORE);
        for (const recipient of recipients) store.put(storedRecipient(campaignId, recipient));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("No se pudieron actualizar destinatarios."));
      });
      recordIndexedDbWrite(recipients);
    } finally {
      database.close();
    }
  }

  async deleteCampaign(campaignId: string): Promise<void> {
    const database = await openFlorMiaDatabase(this.indexedDb);
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([CAMPAIGN_PAYLOAD_STORE, CAMPAIGN_RECIPIENT_STORE], "readwrite");
        transaction.objectStore(CAMPAIGN_PAYLOAD_STORE).delete(campaignId);
        const recipients = transaction.objectStore(CAMPAIGN_RECIPIENT_STORE);
        const cursorRequest = recipients.index("campaignId").openKeyCursor(IDBKeyRange.only(campaignId));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          recipients.delete(cursor.primaryKey);
          cursor.continue();
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo limpiar la campaña."));
      });
      recordIndexedDbWrite({ deleteCampaignId: campaignId });
    } finally {
      database.close();
    }
  }
}
