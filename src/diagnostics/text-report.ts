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

export function formatTechnicalReportText(report: TechnicalReportV1): string {
  const incident = report.incident;
  const capability = incident.capability ?? report.compatibility.failedCapability;
  const lastKnown = capability ? report.compatibility.lastKnownGood[capability] as Record<string, unknown> | undefined : undefined;
  const lastStrategy = lastKnown?.selectedStrategy;
  return [
    "REPORTE PARA CODEX — FLOR MÍA WHATSAPP SENDER",
    "",
    `La extensión Flor Mía WhatsApp Sender dejó de funcionar durante ${available(incident.stepId ?? incident.actionAttempted)}.`,
    `La última estrategia funcional para ${available(capability)} era ${available(lastStrategy)}.`,
    `Actualmente se intentaron ${strategyIds(report)} y no se encontró una coincidencia funcional confirmada.`,
    `El último paso confirmado fue ${available(incident.lastConfirmedStepId)}.`,
    "Analizá el código de la extensión y modificá únicamente lo necesario para recuperar esta capability sin alterar el flujo atómico, checkpoints ni prevención de duplicados.",
    "",
    "RESTRICCIÓN PRINCIPAL",
    "Preservar atomicidad, verificación y checkpoints. No reemplazar por clicks ciegos.",
    "",
    "RESUMEN DEL INCIDENTE",
    `Fecha: ${report.generatedAt}`,
    `Categoría: ${incident.errorCategory}`,
    `Código: ${available(incident.error?.code)}`,
    `Mensaje técnico: ${available(incident.error?.message)}`,
    `Resultado: ${incident.resultSummary}`,
    `Recuperable: ${available(incident.error?.recoverable)}`,
    `Semáforo: ${incident.overallStatus}`,
    `Campaña: ${available(incident.campaignId)}`,
    `Estado campaña: ${available(incident.campaignStatus)}`,
    `Contacto: ${available(incident.recipientPosition)} / ${available(incident.totalRecipients)}`,
    `ID interno: ${available(incident.recipientInternalId)}`,
    `Teléfono: ${available(incident.maskedPhone)}`,
    `Estado contacto: ${available(incident.contactStatus)}`,
    `Paso: ${available(incident.stepId)} (${available(incident.stepKind)})`,
    `Orden de imagen: ${available(incident.imageOrder)}`,
    `Intentos: ${available(incident.attempts)}`,
    `Acción intentada: ${available(incident.actionAttempted)}`,
    "",
    "EVIDENCIA DE COMPATIBILIDAD",
    `Capability fallida: ${available(capability)}`,
    `Última capability exitosa: ${available(report.compatibility.lastSuccessfulCapability)}`,
    `Última estrategia funcional: ${available(lastStrategy)}`,
    `Estrategias actuales intentadas: ${strategyIds(report)}`,
    `Drifts registrados: ${report.compatibility.driftChanges.length}`,
    `Roturas registradas: ${report.compatibility.breakChanges.length}`,
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
