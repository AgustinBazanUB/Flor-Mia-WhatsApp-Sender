import type { CampaignState } from "../campaign/campaign-types";
import type {
  CandidateSummary,
  CompatibilityFailure,
  CompatibilityState,
  LastKnownGoodCapability,
  SelectorFingerprint,
  StrategyAttempt,
  WhatsAppCapability
} from "../compatibility/types";
import type { ContactProcessCheckpoint } from "../engine/types";
import type { ExtensionState, WhatsAppPreflightResult } from "../shared/state";
import {
  sanitizeCampaignForReport,
  sanitizeCandidate,
  sanitizeCheckpointForReport,
  sanitizeDailyLimit,
  sanitizeDiagnosticText,
  sanitizeDiagnosticUrl,
  sanitizeDiagnosticValue,
  sanitizeError
} from "./sanitizer";
import { formatTechnicalReportText } from "./text-report";
import type {
  DiagnosticEnvironment,
  DiagnosticIncident,
  DiagnosticReportBundle,
  ServiceWorkerRecoveryInfo,
  TechnicalReportV1,
  TechnicalTraceRecord
} from "./types";

export interface TechnicalReportInput {
  generatedAt: string;
  extensionVersion: string;
  manifestVersion: number;
  environment: DiagnosticEnvironment;
  incident: DiagnosticIncident;
  state: ExtensionState;
  campaign: CampaignState | null;
  checkpoint: ContactProcessCheckpoint | null;
  compatibility: CompatibilityState;
  trace: TechnicalTraceRecord[];
  serviceWorkerRecovery: ServiceWorkerRecoveryInfo | null;
  includeCampaignName?: boolean;
}

function sanitizeAttempts(attempts: StrategyAttempt[]): Array<Record<string, unknown>> {
  return attempts.map((attempt) => ({
    strategyId: sanitizeDiagnosticText(attempt.strategyId, { maxStringLength: 200 }),
    method: attempt.method,
    priority: attempt.priority,
    result: attempt.result,
    matchedCount: attempt.matchedCount,
    selectedCandidate: attempt.selectedCandidate ? sanitizeCandidate(attempt.selectedCandidate) : null,
    candidates: attempt.candidates.map(sanitizeCandidate)
  }));
}

function sanitizeFingerprint(fingerprint: SelectorFingerprint): Record<string, unknown> {
  const candidate = sanitizeCandidate({
    tagName: fingerprint.tagName,
    role: fingerprint.role,
    ariaLabel: fingerprint.attributes["aria-label"],
    dataTestId: fingerprint.attributes["data-testid"],
    dataIcon: fingerprint.attributes["data-icon"],
    type: fingerprint.attributes.type,
    contentEditable: fingerprint.attributes.contenteditable
  });
  return {
    strategyId: sanitizeDiagnosticText(fingerprint.strategyId, { maxStringLength: 200 }),
    method: sanitizeDiagnosticText(fingerprint.method, { maxStringLength: 80 }),
    tagName: candidate.tagName,
    role: candidate.role ?? null,
    attributes: {
      "aria-label": candidate.ariaLabel ?? null,
      "data-testid": candidate.dataTestId ?? null,
      "data-icon": candidate.dataIcon ?? null,
      type: candidate.type ?? null,
      contenteditable: candidate.contentEditable ?? null
    },
    semanticFingerprint: sanitizeDiagnosticText(fingerprint.semanticFingerprint, { maxStringLength: 500 })
  };
}

function sanitizeLastKnownGood(
  value: CompatibilityState["lastKnownGood"]
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([capability, raw]) => {
    const record = raw as LastKnownGoodCapability;
    return [capability, {
      capability: record.capability,
      extensionVersion: sanitizeDiagnosticText(record.extensionVersion, { maxStringLength: 40 }),
      lastWorkingAt: record.lastWorkingAt,
      selectedStrategy: sanitizeDiagnosticText(record.selectedStrategy, { maxStringLength: 200 }),
      selectorFingerprint: sanitizeFingerprint(record.selectorFingerprint),
      semanticFingerprint: sanitizeDiagnosticText(record.semanticFingerprint, { maxStringLength: 500 })
    }];
  }));
}

function sanitizeFailure(failure: CompatibilityFailure | null): Record<string, unknown> | null {
  if (!failure) return null;
  return {
    capability: failure.capability,
    logicalStep: sanitizeDiagnosticText(failure.logicalStep, { maxStringLength: 200 }),
    expectedStrategies: failure.expectedStrategies.map((strategy) => sanitizeDiagnosticText(strategy, { maxStringLength: 200 })),
    lastKnownWorkingStrategy: failure.lastKnownWorkingStrategy ?? null,
    currentStrategiesAttempted: sanitizeAttempts(failure.currentStrategiesAttempted),
    expectedSemanticElement: sanitizeDiagnosticText(failure.expectedSemanticElement, { maxStringLength: 300 }),
    candidateCount: failure.candidateCount,
    candidateSummaries: failure.candidateSummaries.map(sanitizeCandidate),
    lastSuccessfulCapability: failure.lastSuccessfulCapability ?? null,
    classification: failure.classification,
    campaignId: failure.campaignId ?? null,
    maskedContact: failure.maskedContact ?? null,
    stepId: failure.stepId ?? null,
    attempts: failure.attempts ?? null,
    timestamp: failure.timestamp
  };
}

function sanitizePreflight(preflight: WhatsAppPreflightResult | null, sensitiveStrings: string[]): Record<string, unknown> | null {
  if (!preflight) return null;
  return {
    checkedAt: preflight.checkedAt,
    overallStatus: preflight.overallStatus,
    level: preflight.level,
    requirements: { ...preflight.requirements },
    status: preflight.status,
    message: sanitizeDiagnosticText(preflight.message, { sensitiveStrings }),
    pageDetected: preflight.pageDetected,
    contentScriptConnected: preflight.contentScriptConnected,
    documentReady: preflight.documentReady,
    sessionReady: preflight.sessionReady,
    mainInterfaceReady: preflight.mainInterfaceReady,
    qrDetected: preflight.qrDetected,
    operational: preflight.operational,
    strategiesUsed: preflight.strategiesUsed.map((strategy) => sanitizeDiagnosticText(strategy, { maxStringLength: 200 })),
    capabilities: Object.fromEntries(Object.entries(preflight.capabilities).map(([name, capability]) => [name, {
      state: capability.state,
      required: capability.required,
      logicalStep: sanitizeDiagnosticText(capability.logicalStep, { maxStringLength: 200 }),
      message: sanitizeDiagnosticText(capability.message, { sensitiveStrings }),
      expectedSemanticElement: sanitizeDiagnosticText(capability.expectedSemanticElement, { maxStringLength: 300 }),
      selectedStrategy: capability.selectedStrategy ?? null,
      attempts: sanitizeAttempts(capability.attempts),
      candidateCount: capability.candidateCount,
      candidateSummaries: capability.candidateSummaries.map(sanitizeCandidate),
      fingerprint: capability.fingerprint ? sanitizeFingerprint(capability.fingerprint) : null,
      change: capability.change
    }])),
    failures: preflight.failures.map((failure) => sanitizeFailure(failure))
  };
}

function probableFiles(capability: WhatsAppCapability | null): string[] {
  const base = [
    "src/compatibility/diagnostic-error.ts",
    "src/compatibility/manager.ts",
    "src/campaign/campaign-engine.ts"
  ];
  if (!capability) return base;
  if (["composer", "text_send_action", "outgoing_text_evidence"].includes(capability)) {
    return ["src/whatsapp/selectors.ts", "src/whatsapp/send-text.ts", "src/whatsapp/preflight.ts", ...base];
  }
  if (["attachment_action", "image_file_input", "media_preview", "media_send_action", "outgoing_media_evidence"].includes(capability)) {
    return ["src/whatsapp/selectors.ts", "src/whatsapp/send-image.ts", "src/whatsapp/preflight.ts", ...base];
  }
  return ["src/whatsapp/selectors.ts", "src/whatsapp/preflight.ts", "src/background/whatsapp-transport.ts", ...base];
}

function safeIncident(incident: DiagnosticIncident, sensitiveStrings: string[]): DiagnosticIncident {
  return {
    ...incident,
    campaignName: incident.campaignName ? sanitizeDiagnosticText(incident.campaignName, { sensitiveStrings, maxStringLength: 160 }) : null,
    maskedPhone: incident.maskedPhone ? sanitizeDiagnosticText(incident.maskedPhone, { maxStringLength: 40 }) : null,
    resultSummary: sanitizeDiagnosticText(incident.resultSummary, { sensitiveStrings, maxStringLength: 300 }),
    error: sanitizeError(incident.error, { sensitiveStrings })
  };
}

export function buildTechnicalReport(input: TechnicalReportInput): TechnicalReportV1 {
  const sensitiveStrings = input.campaign?.text ? [input.campaign.text] : [];
  const failure = input.compatibility.lastFailure;
  const failedCapability = failure?.capability ?? input.incident.capability;
  const currentDiscovery = failedCapability && input.state.whatsapp
    ? input.state.whatsapp.capabilities[failedCapability]
    : null;
  return {
    reportSchemaVersion: 1,
    generatedAt: input.generatedAt,
    extension: {
      name: "Flor Mía WhatsApp Sender",
      extensionVersion: input.extensionVersion,
      manifestVersion: input.manifestVersion
    },
    environment: {
      ...input.environment,
      sanitizedUserAgent: input.environment.chromeVersion
        ? `Chrome/${sanitizeDiagnosticText(input.environment.chromeVersion, { maxStringLength: 80 })}`
        : null,
      timezone: input.environment.timezone
        ? sanitizeDiagnosticText(input.environment.timezone, { maxStringLength: 100 })
        : null,
      whatsappUrl: sanitizeDiagnosticUrl(input.environment.whatsappUrl)
    },
    incident: safeIncident({
      ...input.incident,
      campaignName: input.includeCampaignName
        ? input.incident.campaignName ?? input.campaign?.campaignName ?? null
        : null
    }, sensitiveStrings),
    campaign: sanitizeCampaignForReport(input.campaign, { includeCampaignName: input.includeCampaignName }),
    checkpoint: sanitizeCheckpointForReport(input.checkpoint, sensitiveStrings),
    preflight: sanitizePreflight(input.state.whatsapp, sensitiveStrings),
    compatibility: {
      overallStatus: input.compatibility.overallStatus,
      checkedAt: input.compatibility.checkedAt,
      failedCapability: failedCapability ?? null,
      lastSuccessfulCapability: failure?.lastSuccessfulCapability ?? input.incident.lastSuccessfulCapability,
      lastKnownGood: sanitizeLastKnownGood(input.compatibility.lastKnownGood),
      currentDiscovery: currentDiscovery ? {
        capability: currentDiscovery.capability,
        state: currentDiscovery.state,
        selectedStrategy: currentDiscovery.selectedStrategy ?? null,
        attempts: sanitizeAttempts(currentDiscovery.attempts),
        candidateCount: currentDiscovery.candidateCount,
        candidates: currentDiscovery.candidateSummaries.map((candidate: CandidateSummary) => sanitizeCandidate(candidate)),
        change: currentDiscovery.change
      } : null,
      driftChanges: input.compatibility.driftHistory.map((change) => sanitizeDiagnosticValue(change, "", { sensitiveStrings }) as Record<string, unknown>),
      breakChanges: input.compatibility.lastPreflight?.failures
        .filter((item) => item.classification === "break")
        .map((item) => sanitizeFailure(item) ?? {}) ?? []
    },
    dailyLimit: input.campaign ? sanitizeDailyLimit(input.campaign.dailyLimit) : sanitizeDailyLimit(input.state.dailyLimit),
    recentTechnicalOperations: input.state.operations.slice(-20).map((operation) => sanitizeDiagnosticValue(operation, "", { sensitiveStrings }) as Record<string, unknown>),
    trace: input.trace.slice(-200).map((record) => sanitizeDiagnosticValue(record, "", { sensitiveStrings }) as unknown as TechnicalTraceRecord),
    serviceWorkerRecovery: input.serviceWorkerRecovery,
    repairContext: {
      probableFiles: probableFiles(failedCapability ?? null),
      restrictions: [
        "Preservar atomicidad, verificación y checkpoints. No reemplazar por clicks ciegos.",
        "No repetir pasos ya confirmados ni desactivar la prevención de duplicados.",
        "No usar coordenadas, automatización del sistema operativo ni técnicas de evasión.",
        "Modificar únicamente la capability o integración necesaria y conservar ContactEngine/CampaignEngine."
      ]
    },
    privacy: {
      localOnly: true,
      campaignNameIncluded: Boolean(input.includeCampaignName),
      excludedByDefault: [
        "recipient_list",
        "full_phone_numbers",
        "campaign_message_text",
        "chat_content",
        "full_dom_html",
        "cookies_tokens_credentials_qr",
        "image_binary_and_base64"
      ],
      redactionMarker: "[REDACTED]"
    }
  };
}

export function createDiagnosticReportBundle(input: TechnicalReportInput): DiagnosticReportBundle {
  const report = buildTechnicalReport(input);
  return {
    report,
    text: formatTechnicalReportText(report),
    json: JSON.stringify(report, null, 2)
  };
}
