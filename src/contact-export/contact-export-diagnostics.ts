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
    reportSchemaVersion: 2,
    reportType: "CONTACT_EXPORT_DIAGNOSTIC",
    generatedAt,
    extension: {
      name: "Flor Mía WhatsApp Sender",
      version: extensionVersion,
      manifestVersion: 3
    },
    feature: "Contact Export",
    contactExport: {
      status: state.status,
      labelsDetected: state.labels.length,
      selectedLabels,
      lastSuccessfulStep: diagnostic.lastSuccessfulStep,
      failedStep: diagnostic.failedStep,
      label: diagnostic.labelName ? sanitizeDiagnosticText(diagnostic.labelName, { maxStringLength: 100 }) : null,
      reportedContacts: diagnostic.reportedCount,
      collectedUniqueContacts: diagnostic.collectedUniqueContacts,
      strategy: diagnostic.strategy,
      expectedElement: diagnostic.expectedElement,
      candidatesFound: diagnostic.candidateCount,
      processedCount: diagnostic.processedCount,
      lastContactCorrelationId: diagnostic.lastContactCorrelationId,
      errorCode: diagnostic.errorCode,
      errorMessage: diagnostic.errorMessage ? sanitizeDiagnosticText(diagnostic.errorMessage, { maxStringLength: 500 }) : null,
      stack: sanitizeStackTrace(diagnostic.stack),
      summary: state.summary,
      metrics: state.metrics,
      labelResults: state.labelResults.map((result) => ({
        labelId: result.labelId,
        labelName: sanitizeDiagnosticText(result.labelName, { maxStringLength: 100 }),
        reportedCount: result.reportedCount,
        collectedUniqueContacts: result.collectedUniqueContacts,
        resolvedPhones: result.resolvedPhones,
        unresolvedPhones: result.unresolvedPhones,
        rowScans: result.rowScans,
        scrollOperations: result.scrollOperations,
        scopeStrategy: result.scopeStrategy
      }))
    },
    privacy: {
      localOnly: true,
      excluded: ["contact_names", "phone_numbers", "messages", "conversation_content", "cookies", "tokens"],
      contactIdentifiers: "anonymous-correlation-only"
    },
    probableFiles: [
      "src/contact-export/whatsapp-contact-adapter.ts",
      "src/contact-export/contact-deduplicator.ts",
      "src/contact-export/contact-export-store.ts",
      "src/background/contact-export-runtime.ts",
      "src/content/whatsapp.ts",
      "src/contact-export/page.ts"
    ]
  };

  const lines = [
    "REPORTE PARA CODEX / CHATGPT — CONTACT EXPORT DIAGNOSTIC",
    "",
    `Version: ${extensionVersion}`,
    "Feature: Contact Export",
    `Fecha: ${generatedAt}`,
    `Estado: ${state.status}`,
    `Label: ${valueOrDash(diagnostic.labelName)}`,
    `Reported contacts: ${valueOrDash(diagnostic.reportedCount)}`,
    `Collected unique contacts: ${valueOrDash(diagnostic.collectedUniqueContacts)}`,
    `Last successful step: ${valueOrDash(diagnostic.lastSuccessfulStep)}`,
    `Failed step: ${valueOrDash(diagnostic.failedStep)}`,
    `Strategy: ${valueOrDash(diagnostic.strategy)}`,
    `Expected element: ${valueOrDash(diagnostic.expectedElement)}`,
    `Candidates found: ${diagnostic.candidateCount}`,
    `Processed count: ${diagnostic.processedCount}`,
    `Last contact (anonymous ID): ${valueOrDash(diagnostic.lastContactCorrelationId)}`,
    `Error: ${valueOrDash(diagnostic.errorCode)}`,
    `Detail: ${valueOrDash(diagnostic.errorMessage)}`,
    `Stack: ${valueOrDash(sanitizeStackTrace(diagnostic.stack))}`,
    "",
    `Etiquetas detectadas: ${state.labels.length}`,
    `Etiquetas seleccionadas: ${selectedLabels.length ? selectedLabels.join(" | ") : "—"}`,
    `Total encontrados: ${state.summary.found}`,
    `Contactos válidos: ${state.summary.valid}`,
    `Duplicados eliminados: ${state.summary.duplicatesRemoved}`,
    `PHONE_UNRESOLVED / inválidos: ${state.summary.withoutPhone}`,
    `Sin nombre: ${state.summary.withoutName}`,
    `No-contactos excluidos: ${state.summary.excludedNonContacts}`,
    "",
    `Tiempo total: ${state.metrics ? `${state.metrics.durationMs} ms` : "—"}`,
    `Contactos/segundo: ${valueOrDash(state.metrics?.contactsPerSecond)}`,
    `Filas inspeccionadas: ${valueOrDash(state.metrics?.rowScans)}`,
    `Scrolls del contenedor de etiqueta: ${valueOrDash(state.metrics?.scrollOperations)}`,
    `Operaciones visuales: ${valueOrDash(state.metrics?.visualOperations)}`,
    `Chats abiertos durante extracción normal: ${valueOrDash(state.metrics?.chatsOpened)}`,
    "",
    "Privacidad: este reporte no incluye nombres de contactos, teléfonos completos ni contenido de conversaciones."
  ];

  return {
    report,
    text: `${lines.join("\n")}\n`,
    json: JSON.stringify(report, null, 2)
  };
}
