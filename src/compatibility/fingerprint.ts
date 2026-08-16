import type {
  CapabilityDiscovery,
  CompatibilityFailure,
  CompatibilitySnapshot,
  CompatibilityState,
  LastKnownGoodCapability,
  WhatsAppCapability
} from "./types";
import type { WhatsAppPreflightResult } from "../shared/state";

const MAX_DRIFT_HISTORY = 30;

export function createDefaultCompatibilityState(now = new Date().toISOString()): CompatibilityState {
  return {
    schemaVersion: 1,
    overallStatus: "RED",
    checkedAt: null,
    lastKnownGood: {},
    lastPreflight: null,
    driftHistory: [],
    lastFailure: null,
    developmentFault: "none",
    updatedAt: now
  };
}

function fingerprintChanged(
  previous: LastKnownGoodCapability,
  discovery: CapabilityDiscovery
): boolean {
  return previous.selectedStrategy !== discovery.selectedStrategy
    || previous.semanticFingerprint !== discovery.fingerprint?.semanticFingerprint;
}

function failureFor(
  discovery: CapabilityDiscovery,
  previous: LastKnownGoodCapability | undefined,
  checkedAt: string,
  temporary: boolean,
  lastSuccessfulCapability?: WhatsAppCapability
): CompatibilityFailure {
  return {
    capability: discovery.capability,
    logicalStep: discovery.logicalStep,
    expectedStrategies: discovery.attempts.map((attempt) => attempt.strategyId),
    ...(previous ? { lastKnownWorkingStrategy: previous.selectedStrategy } : {}),
    currentStrategiesAttempted: discovery.attempts,
    expectedSemanticElement: discovery.expectedSemanticElement,
    candidateCount: discovery.candidateCount,
    candidateSummaries: discovery.candidateSummaries,
    ...(lastSuccessfulCapability ? { lastSuccessfulCapability } : {}),
    classification: temporary
      ? "temporary"
      : discovery.state === "requires_context"
        ? "context_required"
        : discovery.state === "not_tested"
          ? "not_tested"
          : "break",
    timestamp: checkedAt
  };
}

export function evaluateFunctionalCompatibility(
  preflight: WhatsAppPreflightResult,
  previousState: CompatibilityState,
  extensionVersion: string
): { preflight: WhatsAppPreflightResult; state: CompatibilityState } {
  const lastKnownGood = { ...previousState.lastKnownGood };
  const driftHistory = [...previousState.driftHistory];
  const failures: CompatibilityFailure[] = [];
  let lastSuccessfulCapability: WhatsAppCapability | undefined;
  const temporary = ["loading", "unavailable", "login_required"].includes(preflight.status) || !preflight.documentReady;

  const capabilities = Object.fromEntries(Object.entries(preflight.capabilities).map(([rawName, rawDiscovery]) => {
    const capability = rawName as WhatsAppCapability;
    const discovery = rawDiscovery as CapabilityDiscovery;
    const previous = lastKnownGood[capability];
    let change: CapabilityDiscovery["change"] = "unknown";
    if (discovery.state === "available" && discovery.selectedStrategy && discovery.fingerprint) {
      change = previous && fingerprintChanged(previous, discovery) ? "drift" : "stable";
      if (change === "drift" && previous) {
        driftHistory.push({
          capability,
          fromStrategy: previous.selectedStrategy,
          toStrategy: discovery.selectedStrategy,
          detectedAt: preflight.checkedAt
        });
      }
      lastKnownGood[capability] = {
        capability,
        extensionVersion,
        lastWorkingAt: preflight.checkedAt,
        selectedStrategy: discovery.selectedStrategy,
        selectorFingerprint: discovery.fingerprint,
        semanticFingerprint: discovery.fingerprint.semanticFingerprint
      };
      lastSuccessfulCapability = capability;
    } else if (discovery.required && !temporary) {
      change = discovery.state === "unavailable" ? "break" : "unknown";
      failures.push(failureFor(discovery, previous, preflight.checkedAt, false, lastSuccessfulCapability));
    } else if (discovery.required) {
      failures.push(failureFor(discovery, previous, preflight.checkedAt, true, lastSuccessfulCapability));
    }
    return [capability, { ...discovery, change }];
  })) as WhatsAppPreflightResult["capabilities"];

  const evaluatedPreflight: WhatsAppPreflightResult = {
    ...preflight,
    capabilities,
    failures,
    strategiesUsed: Object.values(capabilities)
      .map((capability) => capability.selectedStrategy)
      .filter((strategy): strategy is string => Boolean(strategy))
  };
  const snapshot: CompatibilitySnapshot = {
    checkedAt: evaluatedPreflight.checkedAt,
    overallStatus: evaluatedPreflight.overallStatus,
    level: evaluatedPreflight.level,
    requirements: evaluatedPreflight.requirements,
    capabilities: Object.fromEntries(Object.entries(capabilities).map(([name, capability]) => [name, {
      state: capability.state,
      ...(capability.selectedStrategy ? { selectedStrategy: capability.selectedStrategy } : {}),
      change: capability.change
    }])) as CompatibilitySnapshot["capabilities"],
    strategiesUsed: evaluatedPreflight.strategiesUsed,
    failures
  };
  return {
    preflight: evaluatedPreflight,
    state: {
      ...previousState,
      overallStatus: evaluatedPreflight.overallStatus,
      checkedAt: evaluatedPreflight.checkedAt,
      lastKnownGood,
      lastPreflight: snapshot,
      driftHistory: driftHistory.slice(-MAX_DRIFT_HISTORY),
      lastFailure: failures[0] ?? null,
      updatedAt: evaluatedPreflight.checkedAt
    }
  };
}
