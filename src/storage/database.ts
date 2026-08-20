import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { recordStorageRead, recordStorageWrite } from "../performance/runtime-metrics";

export const DATABASE_NAME = "flor-mia-whatsapp-sender";
export const DATABASE_VERSION = 2;
export const CAMPAIGN_BLOB_STORE = "campaign-blobs";
export const CAMPAIGN_PAYLOAD_STORE = "campaign-payload";
export const CAMPAIGN_RECIPIENT_STORE = "campaign-recipients";

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      recordStorageRead(true);
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export async function openFlorMiaDatabase(indexedDb: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
  if (!indexedDb) throw new ExtensionError(ERROR_CODES.storageError, "IndexedDB no está disponible.");
  const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(CAMPAIGN_BLOB_STORE)) {
      const store = database.createObjectStore(CAMPAIGN_BLOB_STORE, { keyPath: "key" });
      store.createIndex("campaignId", "campaignId", { unique: false });
    }
    if (!database.objectStoreNames.contains(CAMPAIGN_PAYLOAD_STORE)) {
      database.createObjectStore(CAMPAIGN_PAYLOAD_STORE, { keyPath: "campaignId" });
    }
    if (!database.objectStoreNames.contains(CAMPAIGN_RECIPIENT_STORE)) {
      const store = database.createObjectStore(CAMPAIGN_RECIPIENT_STORE, { keyPath: "key" });
      store.createIndex("campaignId", "campaignId", { unique: false });
    }
  };
  return requestResult(request);
}

export function recordIndexedDbWrite(value: unknown): void {
  recordStorageWrite(value, true);
}
