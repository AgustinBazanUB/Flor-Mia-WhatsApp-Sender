import { createDefaultCompatibilityState } from "./fingerprint";
import {
  isCompatibilityDevelopmentFault,
  WHATSAPP_CAPABILITIES,
  type CapabilityState,
  type CompatibilityChange,
  type CompatibilityFailure,
  type CompatibilitySnapshot,
  type CompatibilityState,
  type LastKnownGoodCapability,
  type SelectorFingerprint,
  type WhatsAppCapability
} from "./types";

const CAPABILITIES = new Set<string>(WHATSAPP_CAPABILITIES);
const CAPABILITY_STATES = new Set<CapabilityState>(["available", "unavailable", "requires_context", "not_tested"]);
const COMPATIBILITY_CHANGES = new Set<CompatibilityChange>(["stable", "drift", "break", "unknown"]);
const PREFLIGHT_LEVELS = new Set(["full", "lightweight", "targeted"]);
const FAILURE_CLASSIFICATIONS = new Set(["temporary", "break", "context_required", "not_tested"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function capability(value: unknown): WhatsAppCapability | null {
  return typeof value === "string" && CAPABILITIES.has(value) ? value as WhatsAppCapability : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, child]) => typeof child !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function normalizeFingerprint(value: unknown): SelectorFingerprint | null {
  if (!isRecord(value)) return null;
  const attributes = stringRecord(value.attributes);
  if (!attributes
    || typeof value.strategyId !== "string"
    || typeof value.method !== "string"
    || typeof value.tagName !== "string"
    || typeof value.semanticFingerprint !== "string") return null;
  return {
    strategyId: value.strategyId,
    method: value.method,
    tagName: value.tagName,
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    attributes,
    semanticFingerprint: value.semanticFingerprint
  };
}

function normalizeLastKnownGoodCapability(
  expectedCapability: WhatsAppCapability,
  value: unknown
): LastKnownGoodCapability | null {
  if (!isRecord(value)) return null;
  const actualCapability = capability(value.capability);
  const selectorFingerprint = normalizeFingerprint(value.selectorFingerprint);
  if (actualCapability !== expectedCapability
    || !selectorFingerprint
    || typeof value.extensionVersion !== "string"
    || typeof value.lastWorkingAt !== "string"
    || typeof value.selectedStrategy !== "string"
    || typeof value.semanticFingerprint !== "string") return null;
  return {
    capability: expectedCapability,
    extensionVersion: value.extensionVersion,
    lastWorkingAt: value.lastWorkingAt,
    selectedStrategy: value.selectedStrategy,
    selectorFingerprint,
    semanticFingerprint: value.semanticFingerprint
  };
}

function normalizeFailure(value: unknown): CompatibilityFailure | null {
  if (!isRecord(value)) return null;
  const failureCapability = capability(value.capability);
  if (!failureCapability
    || typeof value.logicalStep !== "string"
    || !Array.isArray(value.expectedStrategies)
    || !value.expectedStrategies.every((item) => typeof item === "string")
    || !Array.isArray(value.currentStrategiesAttempted)
    || typeof value.expectedSemanticElement !== "string"
    || typeof value.candidateCount !== "number"
    || !Array.isArray(value.candidateSummaries)
    || typeof value.classification !== "string"
    || !FAILURE_CLASSIFICATIONS.has(value.classification)
    || typeof value.timestamp !== "string") return null;
  return value as unknown as CompatibilityFailure;
}

function normalizeSnapshot(value: unknown): CompatibilitySnapshot | null {
  if (!isRecord(value)
    || typeof value.checkedAt !== "string"
    || (value.overallStatus !== "GREEN" && value.overallStatus !== "RED")
    || typeof value.level !== "string"
    || !PREFLIGHT_LEVELS.has(value.level)
    || !isRecord(value.requirements)
    || typeof value.requirements.needsText !== "boolean"
    || typeof value.requirements.needsImages !== "boolean"
    || !isRecord(value.capabilities)
    || !Array.isArray(value.strategiesUsed)
    || !value.strategiesUsed.every((item) => typeof item === "string")
    || !Array.isArray(value.failures)) return null;

  const capabilities: CompatibilitySnapshot["capabilities"] = {};
  for (const [rawCapability, rawState] of Object.entries(value.capabilities)) {
    const name = capability(rawCapability);
    if (!name || !isRecord(rawState)) continue;
    if (typeof rawState.state !== "string" || !CAPABILITY_STATES.has(rawState.state as CapabilityState)) continue;
    if (typeof rawState.change !== "string" || !COMPATIBILITY_CHANGES.has(rawState.change as CompatibilityChange)) continue;
    capabilities[name] = {
      state: rawState.state as CapabilityState,
      ...(typeof rawState.selectedStrategy === "string" ? { selectedStrategy: rawState.selectedStrategy } : {}),
      change: rawState.change as CompatibilityChange
    };
  }
  const failures = value.failures.map(normalizeFailure).filter((item): item is CompatibilityFailure => Boolean(item));
  return {
    checkedAt: value.checkedAt,
    overallStatus: value.overallStatus,
    level: value.level as CompatibilitySnapshot["level"],
    requirements: {
      needsText: value.requirements.needsText,
      needsImages: value.requirements.needsImages
    },
    capabilities,
    strategiesUsed: value.strategiesUsed as string[],
    failures
  };
}

export function normalizeCompatibilityState(value: unknown, now = new Date().toISOString()): CompatibilityState {
  const defaults = createDefaultCompatibilityState(now);
  if (!isRecord(value)) return defaults;

  const rawLastKnownGood = isRecord(value.lastKnownGood) ? value.lastKnownGood : {};
  const lastKnownGood: CompatibilityState["lastKnownGood"] = {};
  for (const name of WHATSAPP_CAPABILITIES) {
    const normalized = normalizeLastKnownGoodCapability(name, rawLastKnownGood[name]);
    if (normalized) lastKnownGood[name] = normalized;
  }
  const newestKnownGood = Object.values(lastKnownGood)
    .filter((item): item is LastKnownGoodCapability => Boolean(item))
    .sort((a, b) => b.lastWorkingAt.localeCompare(a.lastWorkingAt))[0];

  const driftHistory = Array.isArray(value.driftHistory)
    ? value.driftHistory.flatMap((item) => {
        if (!isRecord(item)) return [];
        const driftCapability = capability(item.capability);
        if (!driftCapability
          || typeof item.fromStrategy !== "string"
          || typeof item.toStrategy !== "string"
          || typeof item.detectedAt !== "string") return [];
        return [{
          capability: driftCapability,
          fromStrategy: item.fromStrategy,
          toStrategy: item.toStrategy,
          detectedAt: item.detectedAt
        }];
      }).slice(-30)
    : [];

  const lastPreflight = normalizeSnapshot(value.lastPreflight);
  const lastFailure = normalizeFailure(value.lastFailure);
  return {
    ...defaults,
    schemaVersion: 2,
    overallStatus: value.overallStatus === "GREEN" || value.overallStatus === "RED" ? value.overallStatus : defaults.overallStatus,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    lastKnownGoodExtensionVersion: typeof value.lastKnownGoodExtensionVersion === "string"
      ? value.lastKnownGoodExtensionVersion
      : newestKnownGood?.extensionVersion ?? null,
    lastKnownGood,
    lastPreflight,
    driftHistory,
    lastFailure,
    developmentFault: isCompatibilityDevelopmentFault(value.developmentFault) ? value.developmentFault : "none",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now
  };
}
