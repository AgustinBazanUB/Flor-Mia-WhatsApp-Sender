import type { CampaignPublicStatus } from "../campaign/campaign-types";
import { ERROR_CODES, ExtensionError } from "../shared/errors";
import type { InternalMessageType } from "../shared/protocol";
import { ChromeLocalStorageAdapter, type KeyValueStorage } from "../storage/state-store";

export const WEB_APP_COMMAND_LOG_KEY = "webAppCommandLog";
export const MAX_WEB_APP_COMMAND_RECORDS = 100;

interface WebAppCommandRecord {
  requestId: string;
  type: InternalMessageType;
  campaignId: string;
  resultSequence: number;
  recordedAt: string;
}

interface WebAppCommandLog {
  schemaVersion: 1;
  records: WebAppCommandRecord[];
}

export interface WebAppMutationCommand {
  requestId: string;
  type: InternalMessageType;
  campaignId: string;
  expectedSequence?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validRecord(value: unknown): value is WebAppCommandRecord {
  if (!isRecord(value)) return false;
  return typeof value.requestId === "string"
    && typeof value.type === "string"
    && typeof value.campaignId === "string"
    && Number.isInteger(value.resultSequence)
    && typeof value.recordedAt === "string";
}

export class WebAppCommandGate {
  constructor(
    private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter(),
    private readonly maxRecords = MAX_WEB_APP_COMMAND_RECORDS
  ) {}

  private async load(): Promise<WebAppCommandLog> {
    const stored = (await this.storage.get(WEB_APP_COMMAND_LOG_KEY))[WEB_APP_COMMAND_LOG_KEY];
    if (!isRecord(stored) || stored.schemaVersion !== 1 || !Array.isArray(stored.records)) {
      return { schemaVersion: 1, records: [] };
    }
    return { schemaVersion: 1, records: stored.records.filter(validRecord).slice(-this.maxRecords) };
  }

  async execute(
    command: WebAppMutationCommand,
    loadCurrent: () => Promise<CampaignPublicStatus | null>,
    operation: () => Promise<CampaignPublicStatus>
  ): Promise<CampaignPublicStatus> {
    const log = await this.load();
    const existingIndex = log.records.findIndex((record) => record.requestId === command.requestId);
    const existing = existingIndex >= 0 ? log.records[existingIndex] : undefined;
    if (existing) {
      if (existing.type !== command.type || existing.campaignId !== command.campaignId) {
        throw new ExtensionError(ERROR_CODES.protocolError, "requestId ya fue utilizado para otro comando.", { recoverable: false });
      }
      const current = await loadCurrent();
      if (current?.campaignId === command.campaignId) return current;
      if (existing.resultSequence >= 0) {
        throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña del comando repetido ya no es la campaña activa.");
      }
      log.records.splice(existingIndex, 1);
    }

    if (command.expectedSequence !== undefined) {
      const current = await loadCurrent();
      if (!current || current.campaignId !== command.campaignId) {
        throw new ExtensionError(ERROR_CODES.campaignConflict, "La campaña solicitada no coincide con la activa.");
      }
      if (current.sequence !== command.expectedSequence) {
        throw new ExtensionError(ERROR_CODES.protocolError, "El comando usa una secuencia obsoleta; solicitá el estado actual antes de reintentar.", {
          recoverable: true,
          details: { expectedSequence: command.expectedSequence, currentSequence: current.sequence }
        });
      }
    }

    const pending: WebAppCommandRecord = {
      requestId: command.requestId,
      type: command.type,
      campaignId: command.campaignId,
      resultSequence: -1,
      recordedAt: new Date().toISOString()
    };
    const pendingLog: WebAppCommandLog = {
      schemaVersion: 1,
      records: [...log.records, pending].slice(-this.maxRecords)
    };
    await this.storage.set({ [WEB_APP_COMMAND_LOG_KEY]: pendingLog });
    let result: CampaignPublicStatus;
    try {
      result = await operation();
    } catch (error) {
      await this.storage.set({
        [WEB_APP_COMMAND_LOG_KEY]: {
          schemaVersion: 1,
          records: pendingLog.records.filter((record) => record.requestId !== command.requestId)
        } satisfies WebAppCommandLog
      });
      throw error;
    }
    const completed: WebAppCommandLog = {
      schemaVersion: 1,
      records: pendingLog.records.map((record) => record.requestId === command.requestId
        ? { ...record, resultSequence: result.sequence, recordedAt: new Date().toISOString() }
        : record)
    };
    await this.storage.set({ [WEB_APP_COMMAND_LOG_KEY]: completed });
    return result;
  }
}
