import { sanitizeDiagnosticText, sanitizeStackTrace } from "../diagnostics/sanitizer";
import type { MessageContactWorkflowState } from "./add-contacts-by-message";
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
  generatedAt = new Date().toISOString(),
  messageContactState?: MessageContactWorkflowState | null
): ContactExportDiagnosticBundle {
  const diagnostic = state.diagnostic;
  const selectedLabels = state.labels
    .filter((label) => state.selectedLabelIds.includes(label.id))
    .map((label) => sanitizeDiagnosticText(label.name, { maxStringLength: 100 }));
  const messageDiagnostic = messageContactState ? {
    feature: "Add Contacts By Message",
    status: messageContactState.status,
    targetList: messageContactState.targetLabel?.name
      ? sanitizeDiagnosticText(messageContactState.targetLabel.name, { maxStringLength: 100 })
      : null,
    searchPhrase: messageContactState.search.searchText
      ? sanitizeDiagnosticText(messageContactState.search.searchText, { maxStringLength: 200 })
      : null,
    matchMode: messageContactState.search.mode,
    incomingOnly: messageContactState.search.inboundOnly,
    messagesFound: messageContactState.summary.messagesFound,
    uniqueContacts: messageContactState.summary.uniqueContacts,
    alreadyInList: messageContactState.summary.alreadyInList,
    newContacts: messageContactState.summary.newContacts,
    unresolved: messageContactState.summary.unresolved,
    successfullyAdded: messageContactState.summary.added,
    failed: messageContactState.summary.failed,
    targetCountBefore: messageContactState.targetContactCountBefore,
    targetCountAfter: messageContactState.targetContactCountAfter,
    currentStep: messageContactState.diagnostic.currentStep,
    lastSuccessfulStep: messageContactState.diagnostic.lastSuccessfulStep,
    lastSuccessfulContact: messageContactState.diagnostic.lastSuccessfulContactId,
    failure: messageContactState.diagnostic.errorCode,
    failureMessage: messageContactState.diagnostic.errorMessage
      ? sanitizeDiagnosticText(messageContactState.diagnostic.errorMessage, { maxStringLength: 500 })
      : null,
    strategy: messageContactState.diagnostic.strategy,
    metrics: messageContactState.metrics ? {
      durationMs: messageContactState.metrics.durationMs,
      searchPages: messageContactState.metrics.searchPages,
      messagesScanned: messageContactState.metrics.messagesScanned,
      messagesMatched: messageContactState.metrics.messagesMatched,
      directionUnknown: messageContactState.metrics.directionUnknown,
      excludedNonContacts: messageContactState.metrics.excludedNonContacts,
      chatsOpened: messageContactState.metrics.chatsOpened,
      visualOperations: messageContactState.metrics.visualOperations
    } : null
  } : null;
  const report = {
    reportSchemaVersion: 3,
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
      technicalDetails: diagnostic.technicalDetails,
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
    addContactsByMessage: messageDiagnostic,
    privacy: {
      localOnly: true,
      excluded: ["contact_names", "phone_numbers", "matching_message_bodies", "conversation_history", "cookies", "tokens"],
      searchQueryIncluded: true,
      contactIdentifiers: "anonymous-correlation-only"
    },
    probableFiles: [
      "src/contact-export/whatsapp-contact-adapter.ts",
      "src/contact-export/whatsapp-main-world-resolver.ts",
      "src/contact-export/whatsapp-message-search-main-world.ts",
      "src/contact-export/add-contacts-by-message.ts",
      "src/contact-export/message-contact-store.ts",
      "src/background/message-contact-runtime.ts",
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
    `Technical details: ${Object.keys(diagnostic.technicalDetails).length ? JSON.stringify(diagnostic.technicalDetails) : "—"}`,
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
    "ADD CONTACTS BY MESSAGE",
    `Feature: ${messageDiagnostic ? "Add Contacts By Message" : "—"}`,
    `Target List: ${valueOrDash(messageDiagnostic?.targetList)}`,
    `Search phrase: ${valueOrDash(messageDiagnostic?.searchPhrase)}`,
    `Match mode: ${valueOrDash(messageDiagnostic?.matchMode)}`,
    `Incoming only: ${valueOrDash(messageDiagnostic?.incomingOnly)}`,
    `Messages found: ${valueOrDash(messageDiagnostic?.messagesFound)}`,
    `Unique contacts: ${valueOrDash(messageDiagnostic?.uniqueContacts)}`,
    `Already in list: ${valueOrDash(messageDiagnostic?.alreadyInList)}`,
    `New: ${valueOrDash(messageDiagnostic?.newContacts)}`,
    `Successfully added: ${valueOrDash(messageDiagnostic?.successfullyAdded)}`,
    `Failed: ${valueOrDash(messageDiagnostic?.failed)}`,
    `Current step: ${valueOrDash(messageDiagnostic?.currentStep)}`,
    `Last successful contact: ${valueOrDash(messageDiagnostic?.lastSuccessfulContact)}`,
    `Failure: ${valueOrDash(messageDiagnostic?.failure)}`,
    `Strategy: ${valueOrDash(messageDiagnostic?.strategy)}`,
    `Search chats opened: ${valueOrDash(messageDiagnostic?.metrics?.chatsOpened)}`,
    "",
    "Privacidad: el reporte no incluye nombres de contactos, teléfonos completos, mensajes coincidentes completos ni historial de conversaciones. La frase de búsqueda sí se incluye para poder reproducir el diagnóstico."
  ];

  return {
    report,
    text: `${lines.join("\n")}\n`,
    json: JSON.stringify(report, null, 2)
  };
}
