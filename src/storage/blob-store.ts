import {
  CAMPAIGN_BLOB_STORE,
  openFlorMiaDatabase,
  recordIndexedDbWrite,
  requestResult
} from "./database";

export interface CampaignBlobInput {
  imageId: string;
  order: number;
  name: string;
  type: string;
  blob: Blob;
}

export interface StoredCampaignBlob extends CampaignBlobInput {
  key: string;
  campaignId: string;
  createdAt: string;
}

export class CampaignBlobStore {
  constructor(private readonly indexedDb: IDBFactory = globalThis.indexedDB) {}

  async putCampaignImages(campaignId: string, images: CampaignBlobInput[]): Promise<void> {
    if (!campaignId.trim()) throw new Error("campaignId es obligatorio para guardar imágenes.");
    const database = await openFlorMiaDatabase(this.indexedDb);
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(CAMPAIGN_BLOB_STORE, "readwrite");
        const store = transaction.objectStore(CAMPAIGN_BLOB_STORE);
        for (const image of images) {
          const record: StoredCampaignBlob = {
            ...image,
            key: `${campaignId}:${image.imageId}`,
            campaignId,
            createdAt: new Date().toISOString()
          };
          store.put(record);
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("No se pudieron guardar las imágenes."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Se canceló el guardado de imágenes."));
      });
      recordIndexedDbWrite(images.map(({ blob, ...image }) => ({ ...image, blobSize: blob.size })));
    } finally {
      database.close();
    }
  }

  async getImage(campaignId: string, imageId: string): Promise<StoredCampaignBlob | null> {
    const database = await openFlorMiaDatabase(this.indexedDb);
    try {
      const result = await requestResult(database.transaction(CAMPAIGN_BLOB_STORE).objectStore(CAMPAIGN_BLOB_STORE).get(`${campaignId}:${imageId}`));
      return result as StoredCampaignBlob | undefined ?? null;
    } finally {
      database.close();
    }
  }

  async listCampaignImages(campaignId: string): Promise<StoredCampaignBlob[]> {
    const database = await openFlorMiaDatabase(this.indexedDb);
    try {
      const index = database.transaction(CAMPAIGN_BLOB_STORE).objectStore(CAMPAIGN_BLOB_STORE).index("campaignId");
      const result = await requestResult(index.getAll(IDBKeyRange.only(campaignId)));
      return (result as StoredCampaignBlob[]).sort((a, b) => a.order - b.order);
    } finally {
      database.close();
    }
  }

  async deleteCampaign(campaignId: string): Promise<number> {
    const database = await openFlorMiaDatabase(this.indexedDb);
    try {
      const deleted = await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction(CAMPAIGN_BLOB_STORE, "readwrite");
        const index = transaction.objectStore(CAMPAIGN_BLOB_STORE).index("campaignId");
        const cursorRequest = index.openKeyCursor(IDBKeyRange.only(campaignId));
        let count = 0;
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          transaction.objectStore(CAMPAIGN_BLOB_STORE).delete(cursor.primaryKey);
          count += 1;
          cursor.continue();
        };
        transaction.oncomplete = () => resolve(count);
        transaction.onerror = () => reject(transaction.error ?? new Error("No se pudieron eliminar las imágenes."));
      });
      recordIndexedDbWrite({ deletedCampaign: campaignId, deleted });
      return deleted;
    } finally {
      database.close();
    }
  }
}
