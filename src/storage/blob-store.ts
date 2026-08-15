import { ERROR_CODES, ExtensionError } from "../shared/errors";

const DATABASE_NAME = "flor-mia-whatsapp-sender";
const DATABASE_VERSION = 1;
const STORE_NAME = "campaign-blobs";

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

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export class CampaignBlobStore {
  constructor(private readonly indexedDb: IDBFactory = globalThis.indexedDB) {}

  private async open(): Promise<IDBDatabase> {
    if (!this.indexedDb) throw new ExtensionError(ERROR_CODES.storageError, "IndexedDB no está disponible.");
    const request = this.indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("campaignId", "campaignId", { unique: false });
      }
    };
    return requestResult(request);
  }

  async putCampaignImages(campaignId: string, images: CampaignBlobInput[]): Promise<void> {
    if (!campaignId.trim()) throw new ExtensionError(ERROR_CODES.storageError, "campaignId es obligatorio para guardar imágenes.");
    const database = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
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
    } finally {
      database.close();
    }
  }

  async getImage(campaignId: string, imageId: string): Promise<StoredCampaignBlob | null> {
    const database = await this.open();
    try {
      const result = await requestResult(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(`${campaignId}:${imageId}`));
      return result as StoredCampaignBlob | undefined ?? null;
    } finally {
      database.close();
    }
  }

  async listCampaignImages(campaignId: string): Promise<StoredCampaignBlob[]> {
    const database = await this.open();
    try {
      const index = database.transaction(STORE_NAME).objectStore(STORE_NAME).index("campaignId");
      const result = await requestResult(index.getAll(IDBKeyRange.only(campaignId)));
      return (result as StoredCampaignBlob[]).sort((a, b) => a.order - b.order);
    } finally {
      database.close();
    }
  }

  async deleteCampaign(campaignId: string): Promise<number> {
    const database = await this.open();
    try {
      return await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const index = transaction.objectStore(STORE_NAME).index("campaignId");
        const cursorRequest = index.openKeyCursor(IDBKeyRange.only(campaignId));
        let deleted = 0;
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          transaction.objectStore(STORE_NAME).delete(cursor.primaryKey);
          deleted += 1;
          cursor.continue();
        };
        transaction.oncomplete = () => resolve(deleted);
        transaction.onerror = () => reject(transaction.error ?? new Error("No se pudieron eliminar las imágenes."));
      });
    } finally {
      database.close();
    }
  }
}
