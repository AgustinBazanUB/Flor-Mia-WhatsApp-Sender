import { createDefaultCompatibilityState } from "../compatibility/fingerprint";
import type { CompatibilityDevelopmentFault, CompatibilityState } from "../compatibility/types";
import { ChromeLocalStorageAdapter, type KeyValueStorage } from "./state-store";

export const COMPATIBILITY_STATE_KEY = "whatsappCompatibilityState";

function isCompatibilityState(value: unknown): value is CompatibilityState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CompatibilityState>;
  return candidate.schemaVersion === 2
    && (candidate.overallStatus === "GREEN" || candidate.overallStatus === "RED")
    && typeof candidate.lastKnownGood === "object";
}

export function migrateCompatibilityState(value: unknown): CompatibilityState {
  if (isCompatibilityState(value)) return value;
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown> & Partial<Omit<CompatibilityState, "schemaVersion">>;
    if (candidate.schemaVersion === 1
      && (candidate.overallStatus === "GREEN" || candidate.overallStatus === "RED")
      && candidate.lastKnownGood && typeof candidate.lastKnownGood === "object") {
      const versions = Object.values(candidate.lastKnownGood)
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((a, b) => b.lastWorkingAt.localeCompare(a.lastWorkingAt));
      return {
        ...createDefaultCompatibilityState(),
        ...candidate,
        schemaVersion: 2,
        lastKnownGoodExtensionVersion: versions[0]?.extensionVersion ?? null
      } as CompatibilityState;
    }
  }
  return createDefaultCompatibilityState();
}

export class CompatibilityStore {
  constructor(private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter()) {}

  async load(): Promise<CompatibilityState> {
    const result = await this.storage.get(COMPATIBILITY_STATE_KEY);
    const raw = result[COMPATIBILITY_STATE_KEY];
    const migrated = migrateCompatibilityState(raw);
    if (raw !== undefined && migrated !== raw) await this.save(migrated);
    return migrated;
  }

  async save(state: CompatibilityState): Promise<CompatibilityState> {
    await this.storage.set({ [COMPATIBILITY_STATE_KEY]: state });
    return state;
  }

  async setDevelopmentFault(fault: CompatibilityDevelopmentFault): Promise<CompatibilityState> {
    const current = await this.load();
    return this.save({ ...current, developmentFault: fault, updatedAt: new Date().toISOString() });
  }

  async consumeHealthCheckFault(): Promise<CompatibilityDevelopmentFault> {
    const current = await this.load();
    if (current.developmentFault !== "next_health_check_break") return "none";
    await this.save({ ...current, developmentFault: "none", updatedAt: new Date().toISOString() });
    return "main_interface_capability_break";
  }
}
