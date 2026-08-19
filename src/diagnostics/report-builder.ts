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
  sanitizeCorrelationId,
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
    campaignId: sanitizeCorrelationId(failure.campaignId) ?? null,
    maskedContact: failure.maskedContact ?? null,
    stepId: failure.stepId ?? null,
    attempts: failure.attempts ?? null,
    timestamp: failure.timestamp
  };
}

function preflightTraceSnapshot(record: TechnicalTraceRecord | undefined): Record<string, unknown> | null {
  if (!record) return null;
  return {
    action: record.action,
    outcome: record.outcome,
    startedAt: record.timestampStart,
    completedAt: record.timestampEnd,
    durationMs: record.durationMs,
    capability: record.capability,
    errorCode: record.errorCode
  };
}

function preflightTimeline(trace: TechnicalTraceRecord[]): Record<string, unknown> {
  const preflights = trace.filter((record) => record.action.startsWith("preflight_"));
  const campaignStart = [...trace].reverse().find((record) => record.action === "campaign_start");
  const startMs = campaignStart ? Date.parse(campaignStart.timestampStart) : Number.NaN;
  const endMs = campaignStart?.timestampEnd ? Date.parse(campaignStart.timestampEnd) : Number.NaN;
  const startPreflight = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? preflights.find((record) => {
        const time = Date.parse(record.timestampStart);
        return time >= startMs && time <= endMs;
      })
    : undefined;
  return {
    campaignStartPreflight: preflightTraceSnapshot(startPreflight),
    latestPreflight: preflightTraceSnapshot(preflights.at(-1)),
    latestSuccessfulPreflight: preflightTraceSnapshot([...preflights].reverse().find((record) => record.outcome === "green")),
    latestFailedPreflight: preflightTraceSnapshot([...preflights].reverse().find((record) => record.outcome !== "green"))
  };
}

function openConversationTimeline(trace: TechnicalTraceRecord[]): Array<Record<string, unknown>> {
  const records = trace.filter((record) => record.action.startsWith("open_conversation."));
  const byAttempt = new Map<number, TechnicalTraceRecord[]>();
  for (const record of records) {
    if (record.attempt === null) continue;
    const current = byAttempt.get(record.attempt) ?? [];
    current.push(record);
    byAttempt.set(record.attempt, current);
  }
  return [...byAttempt.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-10)
    .map(([attempt, items]) => ({
      attempt,
      stages: items.map((record) => ({
        stage: record.action.slice("open_conversation.".length),
        outcome: record.outcome,
        startedAt: record.timestampStart,
        completedAt: record.timestampEnd,
        durationMs: record.durationMs,
        errorCode: record.errorCode
      }))
    }));
}

function sanitizePreflight(
  preflight: WhatsAppPreflightResult | null,
  sensitiveStrings: string[],
  trace: TechnicalTraceRecord[],
  campaign: CampaignState | null,
  checkpoint: ContactProcessCheckpoint | null
): Record<string, unknown> | null {
  if (!preflight) return null;
  return {
    snapshotRole: "latest_extension_state_snapshot",
    ...preflightTimeline(trace),
    checkedAt: preflight.checkedAt,
    overallStatus: preflight.overallStatus,
    level: preflight.level,
    purpose: preflight.purpose,
    requirements: { ...preflight.requirements },
    diagnosticComposerMutationDetected: preflight.diagnosticComposerMutationDetected,
    contentGenerationPresent: Boolean(preflight.contentInstanceId),
    campaignTextPresent: Boolean(campaign?.text && campaign.text.trim()),
    campaignTextLength: campaign?.text.length ?? 0,
    textStepCreated: checkpoint?.steps.some((step) => step.kind === "text") ?? false,
    openConversationAttempts: checkpoint?.openConversationAttempts ?? 0,
    openConversationTimeline: openConversationTimeline(trace),
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

function probableFiles(
  incident: DiagnosticIncident,
  capability: WhatsAppCapability | null,
  trace: TechnicalTraceRecord[]
): string[] {
  const errorCode = incident.error?.code ?? null;
  const actions = trace.slice(-30).map((record) => record.action);
  if (errorCode === "CONTACT_CONTEXT_UNVERIFIED"
    || incident.actionAttempted === "openConversation"
    || actions.some((action) => action === "open_conversation" || action.startsWith("open_conversation."))
    || actions.includes("prove_conversation")) {
    return [
      "src/whatsapp/conversation-context.ts",
      "src/content/whatsapp.ts",
      "src/background/contact-adapter.ts",
      "src/background/whatsapp-transport.ts",
      "src/engine/contact-engine.ts",
      "src/campaign/campaign-engine.ts",
      "src/background/service-worker.ts"
    ];
  }
  const base = [
    "src/compatibility/diagnostic-error.ts",
    "src/compatibility/manager.ts",
    "src/campaign/campaign-engine.ts"
  ];
  if (!capability) return ["src/background/service-worker.ts", "src/engine/contact-engine.ts", ...base];
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
    campaignId: sanitizeCorrelationId(incident.campaignId),
    recipientInternalId: sanitizeCorrelationId(incident.recipientInternalId),
    campaignName: incident.campaignName ? sanitizeDiagnosticText(incident.campaignName, { sensitiveStrings, maxStringLength: 160 }) : null,
    maskedPhone: incident.maskedPhone ? sanitizeDiagnosticText(incident.maskedPhone, { maxStringLength: 40 }) : null,
    resultSummary: sanitizeDiagnosticText(incident.resultSummary, { sensitiveStrings, maxStringLength: 300 }),
    error: sanitizeError(incident.error, { sensitiveStrings })
  };
}

export function buildTechnicalReport(input: TechnicalReportInput): TechnicalReportV1 {
  const sensitiveStrings = input.campaign?.text ? [input.campaign.text] : [];
  const failure = input.compatibility.lastFailure;
  const compatibilityCausedIncident = input.incident.errorCategory === "WHATSAPP_UI_CHANGED" || input.incident.capability !== null;
  // Un lastFailure histórico de compatibilidad no debe apropiarse de un incidente de contexto.
  const failedCapability = compatibilityCausedIncident
    ? (input.incident.capability ?? failure?.capability ?? null)
    : null;
  const currentDiscovery = failedCapability && input.state.whatsapp
    ? input.state.whatsapp.capabilities[failedCapability]
    : null;
  const recovery = input.serviceWorkerRecovery
    ? {
        ...input.serviceWorkerRecovery,
        campaignId: sanitizeCorrelationId(input.serviceWorkerRecovery.campaignId),
        relationToIncident: input.serviceWorkerRecovery.campaignId && input.incident.campaignId
          ? input.serviceWorkerRecovery.campaignId === input.incident.campaignId ? "same_campaign" as const : "historical_unrelated" as const
          : "unknown" as const
      }
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
    preflight: sanitizePreflight(input.state.whatsapp, sensitiveStrings, input.trace, input.campaign, input.checkpoint),
    compatibility: {
      overallStatus: input.compatibility.overallStatus,
      checkedAt: input.compatibility.checkedAt,
      failedCapability,
      lastSuccessfulCapability: compatibilityCausedIncident
        ? failure?.lastSuccessfulCapability ?? input.incident.lastSuccessfulCapability
        : null,
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
    serviceWorkerRecovery: recovery,
    repairContext: {
      probableFiles: probableFiles(input.incident, failedCapability, input.trace),
      restrictions: [
        "Preservar atomicidad, verificación y checkpoints. No reemplazar por clicks ciegos.",
        "No repetir pasos ya confirmados ni desactivar la prevención de duplicados.",
        "No usar coordenadas, automatización del sistema operativo ni técnicas de evasión.",
        "Modificar únicamente la integración necesaria y conservar ContactEngine/CampaignEngine."
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
