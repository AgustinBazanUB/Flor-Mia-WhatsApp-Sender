import { describe, expect, it } from "vitest";
import { createDefaultCompatibilityState } from "../src/compatibility/fingerprint";
import { createUnavailablePreflight } from "../src/compatibility/preflight-result";
import type { CompatibilityFailure, CompatibilityState } from "../src/compatibility/types";
import { createDiagnosticIncident } from "../src/diagnostics/incident";
import { createDiagnosticReportBundle } from "../src/diagnostics/report-builder";
import type { TechnicalTraceRecord } from "../src/diagnostics/types";
import { createContactCheckpoint } from "../src/engine/steps";
import type { ContactProcessCheckpoint } from "../src/engine/types";
import { ERROR_CODES, type SerializedExtensionError } from "../src/shared/errors";
import type { ExtensionState } from "../src/shared/state";
import { createDefaultState } from "../src/storage/state-store";

const NOW = "2026-08-18T23:17:56.000Z";
const CAMPAIGN_ID = "current-context-campaign";

function contextFixture() {
  const error: SerializedExtensionError = {
    code: ERROR_CODES.contactContextUnverified,
    message: "No pudimos confirmar que WhatsApp abrió el contacto correcto.",
    recoverable: true,
    details: {
      proofAttempt: 3,
      expectedMaskedPhone: "+54••••••78",
      observedIdentifierType: "phone-jid",
      observedMaskedIdentifier: "+54••••••99",
      proofFailureReason: "recipient_mismatch",
      elapsedMs: 1_250
    }
  };
  const baseCheckpoint = createContactCheckpoint({
    campaignId: CAMPAIGN_ID,
    campaignName: "Campaña de prueba",
    contact: {
      contactId: "recipient-current",
      name: "Cliente autorizado",
      phoneDigits: "5491112345678",
      maskedPhone: "+54••••••78"
    },
    images: [],
    text: "Mensaje autorizado",
    now: NOW
  });
  const checkpoint: ContactProcessCheckpoint = {
    ...baseCheckpoint,
    status: "paused",
    currentStepId: null,
    lastConfirmedStepId: null,
    openConversationAttempts: 3,
    pauseReason: "open_conversation_failed",
    error,
    updatedAt: NOW
  };
  const historicalFailure: CompatibilityFailure = {
    capability: "text_send_action",
    logicalStep: "send-text.send-action",
    expectedStrategies: ["send.primary"],
    lastKnownWorkingStrategy: "send.primary",
    currentStrategiesAttempted: [],
    expectedSemanticElement: "botón de envío de texto",
    candidateCount: 0,
    candidateSummaries: [],
    lastSuccessfulCapability: "composer",
    classification: "break",
    campaignId: "historical-campaign",
    maskedContact: "+54••••••00",
    stepId: "text",
    attempts: 1,
    timestamp: "2026-08-18T23:16:40.000Z"
  };
  const compatibility: CompatibilityState = {
    ...createDefaultCompatibilityState(NOW),
    overallStatus: "RED",
    checkedAt: historicalFailure.timestamp,
    lastFailure: historicalFailure,
    updatedAt: NOW
  };
  const preflight = createUnavailablePreflight("Listo", { level: "lightweight" }, {
    pageDetected: true,
    contentScriptConnected: true,
    status: "ready"
  });
  preflight.checkedAt = "2026-08-18T23:14:29.000Z";
  preflight.documentReady = true;
  preflight.sessionReady = true;
  preflight.mainInterfaceReady = true;
  preflight.operational = true;
  preflight.overallStatus = "GREEN";
  preflight.message = "Listo para enviar.";

  const state: ExtensionState = {
    ...createDefaultState(NOW),
    status: "paused",
    activeContactProcess: checkpoint,
    compatibility,
    whatsapp: preflight,
    errors: [{ ...error, at: NOW }]
  };
  const incident = createDiagnosticIncident({ state, campaign: null, checkpoint, compatibility, online: true });
  if (!incident) throw new Error("La fixture debe producir un incidente de contexto.");
  return { checkpoint, compatibility, state, incident };
}

function traceRecord(
  traceId: string,
  action: string,
  startedAt: string,
  completedAt: string,
  outcome: string,
  capability: TechnicalTraceRecord["capability"] = null
): TechnicalTraceRecord {
  return {
    traceId,
    timestampStart: startedAt,
    timestampEnd: completedAt,
    campaignId: CAMPAIGN_ID,
    contactId: "recipient-current",
    stepId: null,
    attempt: null,
    action,
    outcome,
    errorCode: outcome === "green" || outcome === "running" ? null : ERROR_CODES.preflightFailed,
    errorCategory: outcome === "green" || outcome === "running" ? null : "WHATSAPP_UI_CHANGED",
    verificationMethod: null,
    capability,
    strategy: null,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
  };
}

describe("conversation context diagnostics", () => {
  it("reports CONTACT_CONTEXT_UNVERIFIED as a before-content contact failure, not a stale capability failure", () => {
    const { incident } = contextFixture();
    expect(incident).toMatchObject({
      campaignId: CAMPAIGN_ID,
      stepId: null,
      stepKind: null,
      attempts: 3,
      actionAttempted: "openConversation",
      lastConfirmedStepId: null,
      errorCategory: "CONTACT_ERROR",
      capability: null,
      lastSuccessfulCapability: null,
      pauseReason: "open_conversation_failed"
    });
  });

  it("separates preflight chronology, relevant files and historical recovery in the support report", () => {
    const fixture = contextFixture();
    const trace: TechnicalTraceRecord[] = [
      traceRecord("start-light", "preflight_lightweight", "2026-08-18T23:14:28.950Z", "2026-08-18T23:14:29.011Z", "green"),
      traceRecord("campaign-start", "campaign_start", "2026-08-18T23:14:29.020Z", "2026-08-18T23:14:29.300Z", "running"),
      traceRecord("start-full", "preflight_full", "2026-08-18T23:14:29.030Z", "2026-08-18T23:14:29.110Z", "green"),
      traceRecord("later-full", "preflight_full", "2026-08-18T23:17:07.000Z", "2026-08-18T23:17:56.000Z", "incompatible", "text_send_action")
    ];
    const bundle = createDiagnosticReportBundle({
      generatedAt: NOW,
      extensionVersion: "0.9.2",
      manifestVersion: 3,
      environment: {
        chromeVersion: "151",
        sanitizedUserAgent: "Chrome/151",
        timezone: "America/Argentina/Buenos_Aires",
        timezoneOffsetMinutes: 180,
        online: true,
        whatsappUrl: "https://web.whatsapp.com/",
        connectionState: "online",
        documentReadyState: "complete",
        whatsappLoadState: "ready"
      },
      incident: fixture.incident,
      state: fixture.state,
      campaign: null,
      checkpoint: fixture.checkpoint,
      compatibility: fixture.compatibility,
      trace,
      serviceWorkerRecovery: {
        recoveredAt: "2026-08-18T22:00:00.000Z",
        campaignId: "historical-campaign",
        campaignStatus: "paused",
        checkpointPresent: true,
        checkpointStatus: "paused"
      }
    });

    expect(bundle.report.compatibility.failedCapability).toBeNull();
    expect(bundle.report.compatibility.lastSuccessfulCapability).toBeNull();
    expect(bundle.report.repairContext.probableFiles).toEqual(expect.arrayContaining([
      "src/whatsapp/conversation-context.ts",
      "src/background/contact-adapter.ts",
      "src/background/whatsapp-transport.ts",
      "src/engine/contact-engine.ts"
    ]));
    expect(bundle.report.serviceWorkerRecovery?.relationToIncident).toBe("historical_unrelated");
    const preflight = bundle.report.preflight as Record<string, unknown>;
    expect(preflight.campaignStartPreflight).toMatchObject({ action: "preflight_full", outcome: "green" });
    expect(preflight.latestPreflight).toMatchObject({ action: "preflight_full", outcome: "incompatible" });
    expect(preflight.latestSuccessfulPreflight).toMatchObject({ outcome: "green" });
    expect(preflight.latestFailedPreflight).toMatchObject({ outcome: "incompatible", capability: "text_send_action" });
    expect(bundle.text).toContain("CONTACT_CONTEXT_UNVERIFIED");
    expect(bundle.text).not.toContain("Capability fallida: text_send_action");
  });
});
