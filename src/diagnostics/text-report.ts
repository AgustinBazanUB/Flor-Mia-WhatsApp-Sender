import type { TechnicalReportV1 } from "./types";

function available(value: unknown): string {
  if (value === null || value === undefined || value === "") return "no disponible";
  return String(value);
}

function strategyIds(report: TechnicalReportV1): string {
  const discovery = report.compatibility.currentDiscovery;
  if (!discovery || !Array.isArray(discovery.attempts)) return "no disponibles";
  const ids = discovery.attempts
    .map((attempt) => attempt && typeof attempt === "object" ? (attempt as Record<string, unknown>).strategyId : null)
    .filter((value): value is string => typeof value === "string");
  return ids.length ? ids.join(", ") : "no disponibles";
}

function preflightMoment(report: TechnicalReportV1, key: string): string {
  const value = report.preflight?.[key];
  if (!value || typeof value !== "object") return "no disponible";
  const record = value as Record<string, unknown>;
  return `${available(record.action)} · ${available(record.outcome)} · ${available(record.completedAt ?? record.startedAt)} · ${available(record.durationMs)} ms`;
}

function openConversationTimeline(report: TechnicalReportV1): string[] {
  const raw = report.preflight?.openConversationTimeline;
  if (!Array.isArray(raw) || raw.length === 0) return ["no disponible"];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const attempt = item as Record<string, unknown>;
    const stages = Array.isArray(attempt.stages) ? attempt.stages : [];
    if (stages.length === 0) return [`Intento ${available(attempt.attempt)}: sin etapas registradas`];
    return stages.map((rawStage) => {
      const stage = rawStage && typeof rawStage === "object" ? rawStage as Record<string, unknown> : {};
      return `Intento ${available(attempt.attempt)} · ${available(stage.stage)} · ${available(stage.outcome)} · ${available(stage.durationMs)} ms · ${available(stage.errorCode)}`;
    });
  });
}

function sendSafety(report: TechnicalReportV1): { attempted: boolean; ambiguous: boolean; reconciled: boolean } {
  const steps = report.checkpoint?.steps ?? [];
  const attempted = steps.some((step) => step.verification?.sendAttempted === true);
  const ambiguous = steps.some((step) => step.verification?.outcome === "ambiguous" || step.status === "verification_pending");
  const reconciled = ambiguous && steps.some((step) => step.verification?.method?.includes("reconcil"));
  return { attempted, ambiguous, reconciled };
}

function userSummary(report: TechnicalReportV1): string {
  const code = report.incident.error?.code;
  if (code === "CONTACT_CONTEXT_UNVERIFIED") {
    return "No pudimos confirmar que WhatsApp abrió el contacto correcto. La campaña se pausó antes de enviar contenido para evitar un envío a otra persona.";
  }
  if (code === "INTERFACE_LOADING" || code === "TIMEOUT") {
    return "WhatsApp necesita unos segundos más. No pudimos terminar de abrir el contacto y la campaña se pausó antes de enviar para mantener la seguridad.";
  }
  if (report.incident.errorCategory === "WHATSAPP_UI_CHANGED") {
    return "WhatsApp cambió y necesitamos revisar la conexión antes de continuar la campaña.";
  }
  return report.incident.resultSummary;
}

export function formatTechnicalReportText(report: TechnicalReportV1): string {
  const incident = report.incident;
  const capability = incident.capability ?? report.compatibility.failedCapability;
  const lastKnown = capability ? report.compatibility.lastKnownGood[capability] as Record<string, unknown> | undefined : undefined;
  const lastStrategy = lastKnown?.selectedStrategy;
  const safety = sendSafety(report);
  const capabilityApplies = Boolean(capability);
  const preflight = report.preflight;
  return [
    "REPORTE PARA CODEX — FLOR MÍA WHATSAPP SENDER",
    "",
    "RESUMEN PARA USUARIO",
    userSummary(report),
    "",
    "CAUSA TÉCNICA",
    `Código: ${available(incident.error?.code)}`,
    `Operación real: ${available(incident.actionAttempted ?? incident.stepId)}`,
    `Fase: ${incident.stepId ? available(incident.stepKind) : "before_content / open_conversation"}`,
    `Mensaje técnico: ${available(incident.error?.message)}`,
    `Capability de compatibilidad: ${capabilityApplies ? available(capability) : "no aplica a este incidente"}`,
    "",
    "SEND SAFETY",
    `sendAttempted: ${safety.attempted}`,
    `ambiguous: ${safety.ambiguous}`,
    `reconciled: ${safety.reconciled}`,
    `Último paso confirmado: ${available(incident.lastConfirmedStepId)}`,
    "",
    "CONTENIDO DE CAMPAÑA (SIN TEXTO PRIVADO)",
    `campaignTextPresent: ${available(preflight?.campaignTextPresent)}`,
    `campaignTextLength: ${available(preflight?.campaignTextLength)}`,
    `textStepCreated: ${available(preflight?.textStepCreated)}`,
    `diagnosticComposerMutationDetected: ${available(preflight?.diagnosticComposerMutationDetected)}`,
    `Preflight purpose: ${available(preflight?.purpose)}`,
    "",
    "OPEN CONVERSATION — NAVEGACIÓN / HANDSHAKE / PROOF",
    ...openConversationTimeline(report),
    "",
    "RESUMEN DEL INCIDENTE",
    `Fecha: ${report.generatedAt}`,
    `Categoría: ${incident.errorCategory}`,
    `Resultado: ${incident.resultSummary}`,
    `Recuperable: ${available(incident.error?.recoverable)}`,
    `Compatibilidad general: ${incident.overallStatus}`,
    `Campaña: ${available(incident.campaignId)}`,
    `Estado campaña: ${available(incident.campaignStatus)}`,
    `Contacto: ${available(incident.recipientPosition)} / ${available(incident.totalRecipients)}`,
    `ID interno de correlación: ${available(incident.recipientInternalId)}`,
    `Teléfono: ${available(incident.maskedPhone)}`,
    `Estado contacto: ${available(incident.contactStatus)}`,
    `Paso: ${available(incident.stepId)} (${available(incident.stepKind)})`,
    `Orden de imagen: ${available(incident.imageOrder)}`,
    `Intentos: ${available(incident.attempts)}`,
    "",
    "ESTADO TEMPORAL DE PREFLIGHT",
    `Preflight durante start: ${preflightMoment(report, "campaignStartPreflight")}`,
    `Último preflight ejecutado: ${preflightMoment(report, "latestPreflight")}`,
    `Último preflight exitoso: ${preflightMoment(report, "latestSuccessfulPreflight")}`,
    `Último preflight fallido: ${preflightMoment(report, "latestFailedPreflight")}`,
    "",
    "EVIDENCIA DE COMPATIBILIDAD",
    `Capability fallida del incidente: ${capabilityApplies ? available(capability) : "no aplica"}`,
    `Última capability exitosa relacionada: ${capabilityApplies ? available(report.compatibility.lastSuccessfulCapability) : "no aplica"}`,
    `Última estrategia funcional relacionada: ${capabilityApplies ? available(lastStrategy) : "no aplica"}`,
    `Estrategias actuales intentadas: ${capabilityApplies ? strategyIds(report) : "no aplica"}`,
    `Drifts registrados (históricos, no causa automática): ${report.compatibility.driftChanges.length}`,
    `Roturas registradas: ${report.compatibility.breakChanges.length}`,
    "",
    "RECUPERACIÓN DEL SERVICE WORKER",
    report.serviceWorkerRecovery
      ? `${available(report.serviceWorkerRecovery.recoveredAt)} · ${available(report.serviceWorkerRecovery.relationToIncident)} · campaña ${available(report.serviceWorkerRecovery.campaignId)}`
      : "no disponible",
    "",
    "ENTORNO",
    `Extensión: ${report.extension.extensionVersion} · Manifest V${report.extension.manifestVersion}`,
    `Chrome: ${available(report.environment.chromeVersion)}`,
    `Conexión: ${report.environment.connectionState}`,
    `WhatsApp: ${available(report.environment.whatsappUrl)} · ${available(report.environment.whatsappLoadState)}`,
    `Documento: ${available(report.environment.documentReadyState)}`,
    "",
    "ARCHIVOS PROBABLEMENTE RELACIONADOS",
    ...report.repairContext.probableFiles.map((file) => `- ${file}`),
    "",
    "RESTRICCIONES DE REPARACIÓN",
    ...report.repairContext.restrictions.map((restriction) => `- ${restriction}`),
    "",
    `Trazas técnicas incluidas: ${report.trace.length}`,
    "El JSON técnico se entrega por separado y forma parte de este mismo incidente."
  ].join("\n");
}