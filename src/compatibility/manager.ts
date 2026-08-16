import { compatibilityFailureFromError } from "./diagnostic-error";
import { evaluateFunctionalCompatibility } from "./fingerprint";
import type { CompatibilityState } from "./types";
import type { SerializedExtensionError } from "../shared/errors";
import type { WhatsAppPreflightResult } from "../shared/state";
import type { CompatibilityStore } from "../storage/compatibility-store";

export class CompatibilityManager {
  constructor(
    private readonly store: CompatibilityStore,
    private readonly extensionVersion: string
  ) {}

  async evaluate(preflight: WhatsAppPreflightResult): Promise<{
    preflight: WhatsAppPreflightResult;
    state: CompatibilityState;
  }> {
    const previous = await this.store.load();
    const evaluated = evaluateFunctionalCompatibility(preflight, previous, this.extensionVersion);
    await this.store.save(evaluated.state);
    return evaluated;
  }

  async recordRuntimeFailure(
    error: SerializedExtensionError,
    context: {
      campaignId: string;
      maskedContact: string;
      stepId?: string;
      attempts?: number;
      lastSuccessfulCapability?: NonNullable<CompatibilityState["lastFailure"]>["capability"];
    }
  ): Promise<{
    failure: NonNullable<CompatibilityState["lastFailure"]>;
    state: CompatibilityState;
  } | null> {
    const current = await this.store.load();
    const rawCapability = (error.details?.compatibilityDiagnostic as Record<string, unknown> | undefined)?.capability;
    const previousStrategy = typeof rawCapability === "string"
      ? current.lastKnownGood[rawCapability as keyof typeof current.lastKnownGood]?.selectedStrategy
      : undefined;
    const rawFailure = compatibilityFailureFromError(error, previousStrategy);
    if (!rawFailure) return null;
    const failure = {
      ...rawFailure,
      campaignId: context.campaignId,
      maskedContact: context.maskedContact,
      ...(context.stepId ? { stepId: context.stepId } : {}),
      ...(typeof context.attempts === "number" ? { attempts: context.attempts } : {}),
      ...(context.lastSuccessfulCapability ? { lastSuccessfulCapability: context.lastSuccessfulCapability } : {})
    };
    const checkedAt = failure.timestamp;
    const state: CompatibilityState = {
      ...current,
      overallStatus: "RED",
      checkedAt,
      lastFailure: failure,
      lastPreflight: current.lastPreflight ? {
        ...current.lastPreflight,
        checkedAt,
        overallStatus: "RED",
        failures: [failure, ...current.lastPreflight.failures.filter((item) => item.capability !== failure.capability)]
      } : null,
      updatedAt: checkedAt
    };
    await this.store.save(state);
    return { failure, state };
  }
}

export function applyRuntimeFailureToPreflight(
  preflight: WhatsAppPreflightResult,
  failure: NonNullable<CompatibilityState["lastFailure"]>
): WhatsAppPreflightResult {
  const discovery = preflight.capabilities[failure.capability];
  return {
    ...preflight,
    checkedAt: failure.timestamp,
    operational: false,
    overallStatus: "RED",
    status: "incompatible",
    message: "WhatsApp Web no es compatible actualmente con una o más funciones necesarias.",
    capabilities: {
      ...preflight.capabilities,
      [failure.capability]: {
        ...discovery,
        state: "unavailable",
        required: true,
        message: "La capability dejó de ser resoluble durante la campaña.",
        change: "break"
      }
    },
    failures: [failure, ...preflight.failures.filter((item) => item.capability !== failure.capability)]
  };
}
