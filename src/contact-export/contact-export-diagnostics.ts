import { sanitizeDiagnosticText, sanitizeStackTrace } from "../diagnostics/sanitizer";
import type { ContactExportState } from "./types";

export interface ContactExportDiagnosticBundle {
  report: Record<string, unknown>;
  text: string;
  json: string;
}

function valueOrDash(value: unknown): string {
  if (value == null || value === "") return "—";
  return sanitizeDiagnosticText(String(value), { maxStringLength: 500 });
}

export function createContactExportDiagnosticBundle(
  state: ContactExportState,
  extensionVersion: string,
  generatedAt = new Date().toISOString()
): ContactExportDiagnosticBundle {
  const diagnostic = state.diagnostic;
  const selectedLabels = state.labels
    .filter((label) => state.selectedLabelIds.includes(label.id))
    .map((label) => sanitizeDiagnosticText(label.name, { maxStringLength: 100 }));
  const report = {
    reportSchemaVersion: 1,
    reportType: "CONTACT_EXPORT_DIAGNOSTIC",
    generatedAt,
    extension: {
      name: "Flor Mía WhatsApp Sender",
      version: extensionVersion,
      manifestVersion: 3
    },
    contactExport: {
      status: state.status,
      labelsDetected: state.labels.length,
      selectedLabels,
      lastSuccessfulStep: diagnostic.lastSuccessfulStep,
      failedStep: diagnostic.failedStep,
      label: diagnostic.labelName ? sanitizeDiagnosticText(diagnostic.labelName, { maxStringLength: 100 }) : null,
      strategy: diagnostic.strategy,
      expectedElement: diagnostic.expectedElement,
      candidatesFound: diagnostic.candidateCount,
      processedCount: diagnostic.processedCount,
      lastContactCorrelationId: diagnostic.lastContactCorrelationId,
      errorCode: diagnostic.errorCode,
      errorMessage: diagnostic.errorMessage ? sanitizeDiagnosticText(diagnostic.errorMessage, { maxStringLength: 500 }) : null,
      stack: sanitizeStackTrace(diagnostic.stack),
      summary: state.summary
    },
    privacy: {
      localOnly: true,
      excluded: ["contact_names", "phone_numbers", "messages", "conversation_content", "cookies", "tokens"],
      contactIdentifiers: "anonymous-correlation-only"
    },
    probableFiles: [
      "src/contact-export/whatsapp-contact-adapter.ts",
      "src/contact-export/contact-export-store.ts",
      "src/background/contact-export-runtime.ts",
      "src/content/whatsapp.ts",
      "src/contact-export/page.ts"
    ]
  };

  const lines = [
    "REPORTE PARA CODEX — CONTACT EXPORT DIAGNOSTIC",
    "",
    `Versión de la extensión: ${extensionVersion}`,
    `Fecha: ${generatedAt}`,
    `Estado: ${state.status}`,
    `Último paso funcional: ${valueOrDash(diagnostic.lastSuccessfulStep)}`,
    `Paso fallido: ${valueOrDash(diagnostic.failedStep)}`,
    `Etiqueta: ${valueOrDash(diagnostic.labelName)}`,
    `Estrategia utilizada: ${valueOrDash(diagnostic.strategy)}`,
    `Elemento esperado: ${valueOrDash(diagnostic.expectedElement)}`,
    `Candidatos encontrados: ${diagnostic.candidateCount}`,
    `Cantidad procesada: ${diagnostic.processedCount}`,
    `Último contacto procesado (ID anónimo): ${valueOrDash(diagnostic.lastContactCorrelationId)}`,
    `Error: ${valueOrDash(diagnostic.errorCode)}`,
    `Detalle: ${valueOrDash(diagnostic.errorMessage)}`,
    `Stack: ${valueOrDash(sanitizeStackTrace(diagnostic.stack))}`,
    "",
    `Etiquetas detectadas: ${state.labels.length}`,
    `Etiquetas seleccionadas: ${selectedLabels.length ? selectedLabels.join(" | ") : "—"}`,
    `Total encontrados: ${state.summary.found}`,
    `Contactos válidos: ${state.summary.valid}`,
    `Duplicados eliminados: ${state.summary.duplicatesRemoved}`,
    `Sin teléfono: ${state.summary.withoutPhone}`,
    `Sin nombre: ${state.summary.withoutName}`,
    `No-contactos excluidos: ${state.summary.excludedNonContacts}`,
    "",
    "Privacidad: este reporte no incluye nombres de contactos, teléfonos completos ni contenido de conversaciones."
  ];

  return {
    report,
    text: `${lines.join("\n")}\n`,
    json: JSON.stringify(report, null, 2)
  };
}
