import { describe, expect, it } from "vitest";
import { DEFAULT_CAMPAIGN_POLICY } from "../src/campaign/campaign-policy";
import { createCampaignState } from "../src/campaign/campaign-store";
import { refreshDailyLimit } from "../src/campaign/daily-limit";
import type { CompatibilityFailure, CompatibilityState } from "../src/compatibility/types";
import { createDefaultCompatibilityState } from "../src/compatibility/fingerprint";
import { createUnavailablePreflight } from "../src/compatibility/preflight-result";
import { createDiagnosticIncident } from "../src/diagnostics/incident";
import { createDiagnosticReportBundle } from "../src/diagnostics/report-builder";
import type { TechnicalTraceRecord } from "../src/diagnostics/types";
import { createContactCheckpoint } from "../src/engine/steps";
import type { ContactProcessCheckpoint } from "../src/engine/types";
import { validateCampaignInput } from "../src/shared/campaign";
import { ERROR_CODES, type SerializedExtensionError } from "../src/shared/errors";
import { createDefaultState } from "../src/storage/state-store";

const NOW = "2026-08-15T13:00:00.000Z";
const FULL_PHONE = "+54 9 11 2345-6789";
const RAW_PHONE = "5491123456789";
const CAMPAIGN_MESSAGE = `Este mensaje privado para ${FULL_PHONE} jamás debe exportarse`;

function fixture() {
  const technicalError: SerializedExtensionError = {
    code: ERROR_CODES.whatsappUiChanged,
    message: `No se pudo enviar. Contexto: ${CAMPAIGN_MESSAGE}`,
    recoverable: true,
    details: {
      compatibilityDiagnostic: { capability: "media_send_action" },
      phone: FULL_PHONE,
      accessToken: "private-token-value",
      dataBase64: "Q".repeat(160)
    },
    stack: `ExtensionError: fallo\n at send (https://web.whatsapp.com/send?phone=${RAW_PHONE}&token=private)`
  };
  const validated = validateCampaignInput({
    campaignId: "campaign-august",
    campaignName: "Promoción agosto",
    createdBy: "admin-1",
    recipients: [
      { recipientId: "recipient-1", name: "Primero", phone: "5491111111111", source: "flor_mia" },
      { recipientId: "recipient-2", name: "Juan Pérez", phone: RAW_PHONE, source: "flor_mia" },
      { recipientId: "recipient-3", name: "Tercero", phone: "5491133333333", source: "excel" }
    ],
    message: CAMPAIGN_MESSAGE,
    imageCount: 2,
    imageOrder: [1, 2],
    images: [
      { order: 1, name: "one.png", type: "image/png", size: 1, data: new Uint8Array([1]).buffer },
      { order: 2, name: "two.png", type: "image/png", size: 1, data: new Uint8Array([2]).buffer }
    ],
    totalRecipients: 3
  });
  const baseCampaign = createCampaignState(
    validated,
    DEFAULT_CAMPAIGN_POLICY,
    refreshDailyLimit(null, 1_000, new Date(2026, 7, 15, 10)),
    NOW
  );
  const campaign = {
    ...baseCampaign,
    status: "error" as const,
    currentRecipientIndex: 1,
    activeContactId: "recipient-2",
    lastCompletedContactId: "recipient-1",
    completedRecipients: 1,
    recipients: baseCampaign.recipients.map((recipient) => ({
      ...recipient,
      status: recipient.position === 1 ? "completed" as const : recipient.position === 2 ? "error" as const : "pending" as const
    })),
    blockReason: {
      code: "whatsapp_ui_changed" as const,
      message: `La UI cambió durante ${CAMPAIGN_MESSAGE}`,
      at: NOW,
      recoverable: true,
      error: technicalError
    }
  };
  const initialCheckpoint = createContactCheckpoint({
    campaignId: campaign.campaignId,
    campaignName: campaign.campaignName,
    contact: {
      contactId: "recipient-2",
      name: "Juan Pérez",
      phoneDigits: RAW_PHONE,
      maskedPhone: "+54******6789"
    },
    images: campaign.images,
    text: CAMPAIGN_MESSAGE,
    now: NOW
  });
  const checkpoint: ContactProcessCheckpoint = {
    ...initialCheckpoint,
    status: "failed",
    currentStepId: "image-2",
    lastConfirmedStepId: "image-1",
    pauseReason: "non_recoverable_error",
    error: technicalError,
    steps: initialCheckpoint.steps.map((step) => step.id === "image-1"
      ? {
          ...step,
          status: "confirmed" as const,
          attempts: 1,
          completedAt: NOW,
          verification: { outcome: "confirmed" as const, method: "outgoing-media-dom", observedAt: NOW, sendAttempted: true }
        }
      : step.id === "image-2"
        ? { ...step, status: "failed" as const, attempts: 3, startedAt: NOW, error: technicalError }
        : step),
    history: [
      { timestamp: NOW, campaignId: campaign.campaignId, contactId: "recipient-2", stepId: "image-1", attempt: 1, result: "confirmed", verificationMethod: "outgoing-media-dom" },
      { timestamp: NOW, campaignId: campaign.campaignId, contactId: "recipient-2", stepId: "image-2", attempt: 3, result: "failed", errorCode: ERROR_CODES.whatsappUiChanged }
    ],
    updatedAt: NOW
  };

  const candidate = {
    tagName: "button",
    role: "button",
    ariaLabel: "Enviar a Juan Pérez",
    dataTestId: "compose-btn-send",
    hierarchyHint: "div Juan Pérez > button[role=button]"
  };
  const attempt = {
    strategyId: "media.fallback",
    method: "semantic" as const,
    priority: 2,
    result: "not_found" as const,
    matchedCount: 1,
    candidates: [candidate]
  };
  const preflight = createUnavailablePreflight(`Diagnóstico ${CAMPAIGN_MESSAGE}`, {
    level: "targeted",
    targetedCapability: "media_send_action",
    requirements: { needsText: true, needsImages: true }
  }, { pageDetected: true, contentScriptConnected: true, status: "incompatible" });
  preflight.checkedAt = NOW;
  preflight.capabilities.media_send_action = {
    capability: "media_send_action",
    logicalStep: "send-image.media-send-action",
    state: "unavailable",
    required: true,
    message: `No disponible ${CAMPAIGN_MESSAGE}`,
    expectedSemanticElement: "botón de envío de preview multimedia",
    attempts: [attempt],
    candidateCount: 1,
    candidateSummaries: [candidate],
    change: "break"
  };
  const failure: CompatibilityFailure = {
    capability: "media_send_action",
    logicalStep: "send-image.media-send-action",
    expectedStrategies: ["media.primary", "media.fallback"],
    lastKnownWorkingStrategy: "media.primary",
    currentStrategiesAttempted: [attempt],
    expectedSemanticElement: "botón de envío de preview multimedia",
    candidateCount: 1,
    candidateSummaries: [candidate],
    lastSuccessfulCapability: "media_preview",
    classification: "break",
    campaignId: campaign.campaignId,
    maskedContact: "+54******6789",
    stepId: "image-2",
    attempts: 3,
    timestamp: NOW
  };
  preflight.failures = [failure];
  const defaults = createDefaultCompatibilityState(NOW);
  const compatibility: CompatibilityState = {
    ...defaults,
    overallStatus: "RED",
    checkedAt: NOW,
    lastKnownGood: {
      media_send_action: {
        capability: "media_send_action",
        extensionVersion: "0.4.0",
        lastWorkingAt: "2026-08-14T13:00:00.000Z",
        selectedStrategy: "media.primary",
        selectorFingerprint: {
          strategyId: "media.primary",
          method: "semantic",
          tagName: "button",
          role: "button",
          attributes: { "aria-label": "Enviar a Juan Pérez", "data-testid": "compose-btn-send" },
          semanticFingerprint: "button|role=button|testid=compose-btn-send"
        },
        semanticFingerprint: "button|role=button|testid=compose-btn-send"
      }
    },
    lastPreflight: {
      checkedAt: NOW,
      overallStatus: "RED",
      level: "targeted",
      requirements: { needsText: true, needsImages: true },
      capabilities: { media_send_action: { state: "unavailable", change: "break" } },
      strategiesUsed: ["media.fallback"],
      failures: [failure]
    },
    driftHistory: [{ capability: "media_send_action", fromStrategy: "media.primary", toStrategy: "media.fallback", detectedAt: NOW }],
    lastFailure: failure,
    updatedAt: NOW
  };
  const state = {
    ...createDefaultState(NOW),
    status: "error" as const,
    activeCampaign: campaign,
    activeContactProcess: checkpoint,
    whatsapp: preflight,
    compatibility,
    errors: [{ ...technicalError, at: NOW }],
    operations: [{
      operationId: "operation-1",
      kind: "contact-process" as const,
      success: false,
      startedAt: NOW,
      completedAt: NOW,
      maskedPhone: FULL_PHONE,
      errorCode: ERROR_CODES.whatsappUiChanged
    }]
  };
  const incident = createDiagnosticIncident({ state, campaign, checkpoint, compatibility, online: true });
  if (!incident) throw new Error("La fixture debe producir un incidente.");
  const trace: TechnicalTraceRecord[] = [{
    traceId: "trace-1",
    timestampStart: NOW,
    timestampEnd: NOW,
    campaignId: campaign.campaignId,
    contactId: RAW_PHONE,
    stepId: "image-2",
    attempt: 3,
    action: CAMPAIGN_MESSAGE,
    outcome: "failed",
    errorCode: ERROR_CODES.whatsappUiChanged,
    errorCategory: "WHATSAPP_UI_CHANGED",
    verificationMethod: "outgoing-media-dom",
    capability: "media_send_action",
    strategy: "media.fallback",
    durationMs: 245
  }];
  return { campaign, checkpoint, compatibility, state, incident, trace };
}

function bundle(includeCampaignName = false) {
  const input = fixture();
  return createDiagnosticReportBundle({
    generatedAt: NOW,
    extensionVersion: "0.5.0",
    manifestVersion: 3,
    environment: {
      chromeVersion: "140.0.0.0",
      sanitizedUserAgent: "Mozilla/5.0 Chrome/140.0.0.0 token=private",
      timezone: "America/Buenos_Aires",
      timezoneOffsetMinutes: 180,
      online: true,
      whatsappUrl: `https://web.whatsapp.com/send?phone=${RAW_PHONE}&token=private`,
      connectionState: "online",
      documentReadyState: "complete",
      whatsappLoadState: "incompatible"
    },
    ...input,
    serviceWorkerRecovery: {
      recoveredAt: NOW,
      campaignId: input.campaign.campaignId,
      campaignStatus: "error",
      checkpointPresent: true,
      checkpointStatus: "failed"
    },
    includeCampaignName
  });
}

describe("TechnicalReportV1", () => {
  it("builds a complete structured incident from real campaign and checkpoint evidence", () => {
    const { incident } = fixture();
    expect(incident).toMatchObject({
      incidentSchemaVersion: 1,
      campaignId: "campaign-august",
      recipientInternalId: "recipient-2",
      recipientPosition: 2,
      totalRecipients: 3,
      stepId: "image-2",
      stepKind: "image",
      imageOrder: 2,
      attempts: 3,
      lastConfirmedStepId: "image-1",
      errorCategory: "WHATSAPP_UI_CHANGED",
      capability: "media_send_action",
      lastSuccessfulCapability: "media_preview",
      overallStatus: "RED"
    });
  });

  it("produces Spanish repair text, stable JSON and all required diagnostic evidence", () => {
    const result = bundle();
    expect(result.report.reportSchemaVersion).toBe(1);
    expect(JSON.parse(result.json)).toEqual(result.report);
    expect(result.text).toContain("REPORTE PARA CODEX — FLOR MÍA WHATSAPP SENDER");
    expect(result.text).toContain("Preservar atomicidad, verificación y checkpoints. No reemplazar por clicks ciegos.");
    expect(result.text).toContain("media.primary");
    expect(result.report.compatibility.currentDiscovery).not.toBeNull();
    expect(result.report.compatibility.lastKnownGood).toHaveProperty("media_send_action");
    expect(result.report.checkpoint?.currentStepId).toBe("image-2");
    expect(result.report.campaign?.progress).toEqual({ completed: 1, total: 3, percentage: 33.33 });
    expect(result.report.trace).toHaveLength(1);
    expect(result.report.serviceWorkerRecovery?.checkpointPresent).toBe(true);
    expect(result.report.environment.whatsappUrl).toBe("https://web.whatsapp.com/send");
    expect(result.report.campaign?.campaignName).toBeNull();
    expect(result.report.incident.campaignName).toBeNull();
  });

  it("removes full phones, messages, names, base64, cookies and tokens from the complete report", () => {
    const serialized = bundle().json;
    for (const forbidden of [
      FULL_PHONE,
      RAW_PHONE,
      CAMPAIGN_MESSAGE,
      "Juan Pérez",
      "private-token-value",
      "Q".repeat(160),
      "phone=",
      "token=private"
    ]) expect(serialized).not.toContain(forbidden);
    expect(serialized).not.toContain("recipients");
    expect(serialized).not.toContain("phoneDigits");
    expect(serialized).not.toContain("countedContactKeys");
  });

  it("includes the campaign name only with explicit opt-in", () => {
    const result = bundle(true);
    expect(result.report.privacy.campaignNameIncluded).toBe(true);
    expect(result.report.campaign?.campaignName).toBe("Promoción agosto");
    expect(result.report.incident.campaignName).toBe("Promoción agosto");
  });

  it("is deterministic for fixed evidence and keeps a stable diagnostic snapshot", () => {
    const first = bundle();
    const second = bundle();
    expect(second.json).toBe(first.json);
    expect({
      schema: first.report.reportSchemaVersion,
      incident: {
        disposition: first.report.incident.disposition,
        category: first.report.incident.errorCategory,
        capability: first.report.incident.capability,
        step: first.report.incident.stepId,
        position: `${first.report.incident.recipientPosition}/${first.report.incident.totalRecipients}`
      },
      compatibility: {
        overall: first.report.compatibility.overallStatus,
        lastSuccessful: first.report.compatibility.lastSuccessfulCapability,
        traces: first.report.trace.length
      },
      privacy: first.report.privacy
    }).toMatchInlineSnapshot(`
      {
        "compatibility": {
          "lastSuccessful": "media_preview",
          "overall": "RED",
          "traces": 1,
        },
        "incident": {
          "capability": "media_send_action",
          "category": "WHATSAPP_UI_CHANGED",
          "disposition": "error",
          "position": "2/3",
          "step": "image-2",
        },
        "privacy": {
          "campaignNameIncluded": false,
          "excludedByDefault": [
            "recipient_list",
            "full_phone_numbers",
            "campaign_message_text",
            "chat_content",
            "full_dom_html",
            "cookies_tokens_credentials_qr",
            "image_binary_and_base64",
          ],
          "localOnly": true,
          "redactionMarker": "[REDACTED]",
        },
        "schema": 1,
      }
    `);
  });
});
