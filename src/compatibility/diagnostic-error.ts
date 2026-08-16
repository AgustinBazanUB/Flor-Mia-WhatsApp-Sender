import type { CapabilityDiscovery, CompatibilityFailure, WhatsAppCapability } from "./types";
import { ERROR_CODES, ExtensionError, type SerializedExtensionError } from "../shared/errors";

export const COMPATIBILITY_ERROR_CODES = new Set<string>([
  ERROR_CODES.capabilityUnavailable,
  ERROR_CODES.whatsappUiChanged,
  ERROR_CODES.selectorStrategyExhausted,
  ERROR_CODES.preflightFailed
]);

export function capabilityResolutionError(
  discovery: CapabilityDiscovery,
  message: string,
  cause?: unknown
): ExtensionError {
  return new ExtensionError(ERROR_CODES.selectorStrategyExhausted, message, {
    recoverable: false,
    cause,
    details: {
      compatibilityDiagnostic: {
        capability: discovery.capability,
        logicalStep: discovery.logicalStep,
        expectedStrategies: discovery.attempts.map((attempt) => attempt.strategyId),
        currentStrategiesAttempted: discovery.attempts,
        expectedSemanticElement: discovery.expectedSemanticElement,
        candidateCount: discovery.candidateCount,
        candidateSummaries: discovery.candidateSummaries,
        timestamp: new Date().toISOString()
      }
    }
  });
}

export function capabilityUnavailableError(
  discovery: CapabilityDiscovery,
  message: string,
  cause?: unknown
): ExtensionError {
  const exhausted = capabilityResolutionError(discovery, message, cause);
  return new ExtensionError(ERROR_CODES.capabilityUnavailable, message, {
    recoverable: false,
    cause,
    details: exhausted.details
  });
}

export function compatibilityFailureFromError(
  error: SerializedExtensionError,
  lastKnownWorkingStrategy?: string
): CompatibilityFailure | null {
  if (!COMPATIBILITY_ERROR_CODES.has(error.code)) return null;
  const raw = error.details?.compatibilityDiagnostic;
  if (!raw || typeof raw !== "object") return null;
  const diagnostic = raw as Record<string, unknown>;
  if (typeof diagnostic.capability !== "string" || typeof diagnostic.logicalStep !== "string") return null;
  return {
    capability: diagnostic.capability as WhatsAppCapability,
    logicalStep: diagnostic.logicalStep,
    expectedStrategies: Array.isArray(diagnostic.expectedStrategies)
      ? diagnostic.expectedStrategies.filter((item): item is string => typeof item === "string")
      : [],
    ...(lastKnownWorkingStrategy ? { lastKnownWorkingStrategy } : {}),
    currentStrategiesAttempted: Array.isArray(diagnostic.currentStrategiesAttempted)
      ? diagnostic.currentStrategiesAttempted as CompatibilityFailure["currentStrategiesAttempted"]
      : [],
    expectedSemanticElement: typeof diagnostic.expectedSemanticElement === "string" ? diagnostic.expectedSemanticElement : "elemento semántico requerido",
    candidateCount: typeof diagnostic.candidateCount === "number" ? diagnostic.candidateCount : 0,
    candidateSummaries: Array.isArray(diagnostic.candidateSummaries)
      ? diagnostic.candidateSummaries as CompatibilityFailure["candidateSummaries"]
      : [],
    classification: "break",
    timestamp: typeof diagnostic.timestamp === "string" ? diagnostic.timestamp : new Date().toISOString()
  };
}
