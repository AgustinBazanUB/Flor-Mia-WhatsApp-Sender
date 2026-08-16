import type { ContactCheckpointRepository, ContactProcessCheckpoint } from "../engine/types";
import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { ChromeLocalStorageAdapter, type KeyValueStorage } from "./state-store";

const ACTIVE_CHECKPOINT_KEY = "activeContactCheckpoint";

function isCheckpoint(value: unknown): value is ContactProcessCheckpoint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ContactProcessCheckpoint>;
  return candidate.schemaVersion === 1
    && typeof candidate.checkpointId === "string"
    && typeof candidate.campaignId === "string"
    && Array.isArray(candidate.steps);
}

export class ContactCheckpointStore implements ContactCheckpointRepository {
  constructor(private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter()) {}

  async loadActive(): Promise<ContactProcessCheckpoint | null> {
    const result = await this.storage.get(ACTIVE_CHECKPOINT_KEY);
    const checkpoint = result[ACTIVE_CHECKPOINT_KEY];
    if (checkpoint === null || checkpoint === undefined) return null;
    if (!isCheckpoint(checkpoint)) {
      throw new ExtensionError(ERROR_CODES.storageError, "El checkpoint activo no tiene un formato válido.", { recoverable: false });
    }
    return checkpoint;
  }

  async saveActive(checkpoint: ContactProcessCheckpoint): Promise<ContactProcessCheckpoint> {
    if (!isCheckpoint(checkpoint)) {
      throw new ExtensionError(ERROR_CODES.storageError, "No se puede guardar un checkpoint inválido.", { recoverable: false });
    }
    await this.storage.set({ [ACTIVE_CHECKPOINT_KEY]: checkpoint });
    return checkpoint;
  }

  async clearActive(): Promise<void> {
    await this.storage.set({ [ACTIVE_CHECKPOINT_KEY]: null });
  }
}
