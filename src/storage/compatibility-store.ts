import { createDefaultCompatibilityState } from "../compatibility/fingerprint";
import type { CompatibilityDevelopmentFault, CompatibilityState } from "../compatibility/types";
import { ChromeLocalStorageAdapter, type KeyValueStorage } from "./state-store";

export const COMPATIBILITY_STATE_KEY = "whatsappCompatibilityState";

function isCompatibilityState(value: unknown): value is CompatibilityState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CompatibilityState>;
  return candidate.schemaVersion === 1
    && (candidate.overallStatus === "GREEN" || candidate.overallStatus === "RED")
    && typeof candidate.lastKnownGood === "object";
}

export class CompatibilityStore {
  constructor(private readonly storage: KeyValueStorage = new ChromeLocalStorageAdapter()) {}

  async load(): Promise<CompatibilityState> {
    const result = await this.storage.get(COMPATIBILITY_STATE_KEY);
    const raw = result[COMPATIBILITY_STATE_KEY];
    return isCompatibilityState(raw) ? raw : createDefaultCompatibilityState();
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
