import { normalizeCompatibilityState } from "../compatibility/state-normalizer";
import type { CompatibilityDevelopmentFault, CompatibilityState } from "../compatibility/types";
import { ChromeLocalStorageAdapter, type KeyValueStorage } from "./state-store";

export const COMPATIBILITY_STATE_KEY = "whatsappCompatibilityState";

export function migrateCompatibilityState(value: unknown): CompatibilityState {
  return normalizeCompatibilityState(value);
}

export class CompatibilityStore {
  constructor(private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter()) {}

  async load(): Promise<CompatibilityState> {
    const result = await this.storage.get(COMPATIBILITY_STATE_KEY);
    const raw = result[COMPATIBILITY_STATE_KEY];
    const migrated = migrateCompatibilityState(raw);
    if (raw !== undefined && JSON.stringify(migrated) !== JSON.stringify(raw)) await this.save(migrated);
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
