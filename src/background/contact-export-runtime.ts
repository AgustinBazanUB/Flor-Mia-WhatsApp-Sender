import { createId } from "../shared/ids";
import { ERROR_CODES, ExtensionError, serializeError } from "../shared/errors";
import { INTERNAL_MESSAGE_TYPES, type InternalRequestMap } from "../shared/protocol";
import { deduplicateContactCandidates } from "../contact-export/contact-deduplicator";
import { collectContactsFromWhatsAppMainWorld, mergeHydratedPhonesIntoCollection, resolveWhatsAppLidsInMainWorld } from "../contact-export/whatsapp-main-world-resolver";
import type { ContactExportStore } from "../contact-export/contact-export-store";
import {
  CONTACT_EXPORT_ERROR_CODES,
  type ContactExportProgress,
  type ContactExportState
} from "../contact-export/types";
import type { WhatsAppTransport } from "./whatsapp-transport";


const CONTACT_EXPORT_TECHNICAL_DETAIL_KEYS = [
  "scopeCandidateCount",
  "scopeCandidateSummary",
  "beforePaneFingerprintPresent",
  "scrollRootId",
  "scrollRootRole",
  "scrollTop",
  "scrollHeight",
  "clientHeight",
  "scrollState",
  "visibleRows",
  "expectedCount",
  "collectedCount",
  "candidateCount",
  "internalChatCount",
  "internalLabelIdPresent",
  "mainWorldReason",
  "resolvedPhones",
  "unresolvedPhones",
  "phoneLookupAttempted",
  "phoneLookupLocalResolved",
  "phoneLookupServerQueried",
  "phoneLookupServerResolved",
  "phoneLookupRemaining",
  "phoneLookupQuerySupported",
  "visualHydrationUsed"
] as const;

function safeTechnicalDetails(details: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  if (!details) return {};
  const output: Record<string, string | number | boolean | null> = {};
  for (const key of CONTACT_EXPORT_TECHNICAL_DETAIL_KEYS) {
    const value = details[key];
    if (value == null) output[key] = null;
    else if (typeof value === "number" || typeof value === "boolean") output[key] = value;
    else if (typeof value === "string") output[key] = value.slice(0, 1200);
  }
  return output;
}

export class ContactExportRuntime {
  constructor(
    private readonly store: ContactExportStore,
    private readonly transport: WhatsAppTransport
  ) {}

  async getState(): Promise<ContactExportState> {
    return this.store.load();
  }

  async reset(): Promise<ContactExportState> {
    return this.store.reset();
  }

  async detectLabels(): Promise<ContactExportState> {
    const operationId = createId("contact-export-labels");
    await this.store.patch({
      status: "detecting_labels",
      operationId,
      labels: [],
      selectedLabelIds: [],
      contacts: [],
      problems: [],
      metrics: null,
      labelResults: [],
      progress: null,
      diagnostic: {
        status: "unknown",
        lastSuccessfulStep: "whatsapp_tab_detected",
        failedStep: null,
        labelName: null,
        strategy: null,
        expectedElement: "Etiquetas/Listas de WhatsApp Business",
        candidateCount: 0,
        processedCount: 0,
        reportedCount: null,
        collectedUniqueContacts: null,
        lastContactCorrelationId: null,
        errorCode: null,
        errorMessage: null,
        stack: null,
        technicalDetails: {},
        updatedAt: new Date().toISOString()
      }
    });
    const tab = await this.transport.requireTab();
    try {
      const result = await this.transport.sendWhenContentReady(
        INTERNAL_MESSAGE_TYPES.whatsappContactExportDetectLabels,
        { operationId },
        tab.id,
        10_000
      );
      return this.store.patch({
        status: "ready",
        operationId: null,
        labels: result.labels,
        selectedLabelIds: [],
        diagnostic: {
          status: "green",
          lastSuccessfulStep: "labels_detected",
          failedStep: null,
          labelName: null,
          strategy: result.strategy,
          expectedElement: "Etiquetas/Listas de WhatsApp Business",
          candidateCount: result.candidateCount,
          processedCount: 0,
          reportedCount: null,
          collectedUniqueContacts: null,
          lastContactCorrelationId: null,
          errorCode: null,
          errorMessage: null,
          stack: null,
          technicalDetails: {},
          updatedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      await this.recordFailure(error, "detect_labels", null, "Etiquetas/Listas de WhatsApp Business");
      throw error;
    }
  }

  async analyze(selectedLabelIds: string[]): Promise<ContactExportState> {
    const current = await this.store.load();
    const selectedSet = new Set(selectedLabelIds);
    const labels = current.labels.filter((label) => selectedSet.has(label.id));
    if (!labels.length) throw new ExtensionError(ERROR_CODES.invalidInput, "Seleccioná al menos una etiqueta.");
    if (labels.length !== selectedSet.size) throw new ExtensionError(ERROR_CODES.invalidInput, "Una etiqueta seleccionada ya no está disponible. Detectá las etiquetas nuevamente.");

    const operationId = createId("contact-export-analyze");
    await this.store.patch({
      status: "analyzing",
      operationId,
      selectedLabelIds: labels.map((label) => label.id),
      contacts: [],
      problems: [],
      metrics: null,
      labelResults: [],
      progress: {
        operationId,
        processed: 0,
        totalHint: labels.reduce((sum, label) => sum + (label.countHint ?? 0), 0) || null,
        percent: 0,
        currentLabel: labels[0]?.name ?? null,
        labelIndex: 1,
        totalLabels: labels.length,
        currentContact: 0,
        updatedAt: new Date().toISOString()
      },
      diagnostic: {
        ...current.diagnostic,
        status: "unknown",
        lastSuccessfulStep: "labels_selected",
        failedStep: null,
        labelName: labels[0]?.name ?? null,
        expectedElement: "Listado exclusivo de la etiqueta seleccionada",
        candidateCount: 0,
        processedCount: 0,
        reportedCount: labels[0]?.countHint ?? null,
        collectedUniqueContacts: 0,
        errorCode: null,
        errorMessage: null,
        stack: null,
        technicalDetails: {},
        updatedAt: new Date().toISOString()
      }
    });

    const tab = await this.transport.requireTab();
    try {
      const structured = await collectContactsFromWhatsAppMainWorld(tab.id, labels);
      let resolutionStats = {
        attempted: 0, localResolved: 0, serverQueried: 0, serverResolved: 0,
        remaining: 0, querySupported: false
      };
      let structuredResult = structured;
      if (structured) {
        const unresolvedLids = structured.candidates
          .filter((candidate) => candidate.phoneStatus !== "resolved" && /^\d{8,20}@lid$/i.test(candidate.contactId ?? ""))
          .map((candidate) => candidate.contactId!)
          .filter((id, index, all) => all.indexOf(id) === index);

        if (unresolvedLids.length) {
          const batch = await resolveWhatsAppLidsInMainWorld(tab.id, unresolvedLids);
          const merged = mergeHydratedPhonesIntoCollection(structured, {
            candidates: [],
            hydratedPhones: batch.phones,
            hydrationPasses: batch.serverQueried > 0 ? 2 : 1,
            strategy: "server-assisted-lid-map"
          });
          structuredResult = merged.collection;
          resolutionStats = {
            attempted: unresolvedLids.length,
            localResolved: batch.localResolved,
            serverQueried: batch.serverQueried,
            serverResolved: batch.serverResolved,
            remaining: merged.remaining,
            querySupported: batch.querySupported
          };
        }

        const completedStructured = structuredResult ?? structured;
        await this.recordProgress({
          operationId,
          processed: completedStructured.candidates.length,
          totalHint: completedStructured.labelResults.reduce((sum, item) => sum + (item.reportedCount ?? item.collectedUniqueContacts), 0) || null,
          percent: 100,
          currentLabel: labels.at(-1)?.name ?? null,
          labelIndex: labels.length,
          totalLabels: labels.length,
          currentContact: completedStructured.candidates.length,
          metrics: completedStructured.metrics,
          labelResults: completedStructured.labelResults
        });
      }
      const result = structuredResult
        ? { candidates: structuredResult.candidates, strategy: structuredResult.strategy }
        : await this.transport.sendWhenContentReady(
            INTERNAL_MESSAGE_TYPES.whatsappContactExportAnalyze,
            { operationId, labels },
            tab.id,
            Math.max(60_000, labels.length * 60_000)
          );
      const deduplicated = deduplicateContactCandidates(result.candidates);
      const latest = await this.store.load();
      const lastLabelResult = latest.labelResults.at(-1) ?? null;
      return this.store.patch({
        status: "completed",
        operationId: null,
        contacts: deduplicated.contacts,
        problems: deduplicated.problems,
        summary: deduplicated.summary,
        metrics: latest.metrics,
        labelResults: latest.labelResults,
        progress: {
          operationId,
          processed: deduplicated.summary.found,
          totalHint: deduplicated.summary.found,
          percent: 100,
          currentLabel: labels.at(-1)?.name ?? null,
          labelIndex: labels.length,
          totalLabels: labels.length,
          currentContact: deduplicated.summary.found,
          ...(latest.metrics ? { metrics: latest.metrics } : {}),
          ...(latest.labelResults.length ? { labelResults: latest.labelResults } : {}),
          updatedAt: new Date().toISOString()
        },
        diagnostic: {
          ...deduplicated.diagnostic,
          status: "green",
          lastSuccessfulStep: resolutionStats.attempted > 0
            ? "nonvisual_lid_phone_resolution_completed"
            : "label_scoped_phone_first_analysis_completed",
          labelName: labels.at(-1)?.name ?? null,
          strategy: result.strategy,
          candidateCount: result.candidates.length,
          processedCount: deduplicated.summary.found,
          reportedCount: lastLabelResult?.reportedCount ?? null,
          collectedUniqueContacts: lastLabelResult?.collectedUniqueContacts ?? deduplicated.summary.found,
          technicalDetails: resolutionStats.attempted > 0 ? {
            phoneLookupAttempted: resolutionStats.attempted,
            phoneLookupLocalResolved: resolutionStats.localResolved,
            phoneLookupServerQueried: resolutionStats.serverQueried,
            phoneLookupServerResolved: resolutionStats.serverResolved,
            phoneLookupRemaining: resolutionStats.remaining,
            phoneLookupQuerySupported: resolutionStats.querySupported,
            visualHydrationUsed: false
          } : {},
          updatedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return this.store.patch({ status: "cancelled", operationId: null });
      }
      const serialized = serializeError(error);
      if (serialized.code === ERROR_CODES.internal && String(serialized.message).includes(CONTACT_EXPORT_ERROR_CODES.cancelled)) {
        return this.store.patch({ status: "cancelled", operationId: null });
      }
      const latest = await this.store.load();
      await this.recordFailure(error, "label_scoped_contact_extraction", latest.progress?.currentLabel ?? null, "Listado exclusivo de la etiqueta seleccionada");
      throw error;
    }
  }

  async cancel(): Promise<ContactExportState> {
    const current = await this.store.load();
    if (!current.operationId || !["analyzing", "cancelling"].includes(current.status)) return current;
    await this.store.patch({ status: "cancelling" });
    const tab = await this.transport.findTab();
    if (tab?.id) {
      try {
        await this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappContactExportCancel, { operationId: current.operationId }, tab.id);
      } catch {
        // La operación también queda cancelada si la pestaña se cerró durante el análisis.
      }
    }
    return this.store.patch({ status: "cancelled", operationId: null });
  }

  async recordProgress(payload: InternalRequestMap["CONTACT_EXPORT_PROGRESS"]): Promise<ContactExportState> {
    const current = await this.store.load();
    if (current.operationId !== payload.operationId || current.status !== "analyzing") return current;
    const progress: ContactExportProgress = {
      ...payload,
      updatedAt: new Date().toISOString()
    };
    const lastLabel = payload.labelResults?.at(-1) ?? current.labelResults.at(-1) ?? null;
    return this.store.patch({
      progress,
      ...(payload.metrics ? { metrics: payload.metrics } : {}),
      ...(payload.labelResults ? { labelResults: payload.labelResults } : {}),
      diagnostic: {
        ...current.diagnostic,
        lastSuccessfulStep: "label_scoped_contact_extraction",
        labelName: payload.currentLabel,
        strategy: lastLabel?.scopeStrategy ?? current.diagnostic.strategy,
        candidateCount: payload.processed,
        processedCount: payload.processed,
        reportedCount: lastLabel?.reportedCount ?? current.diagnostic.reportedCount,
        collectedUniqueContacts: lastLabel?.collectedUniqueContacts ?? current.diagnostic.collectedUniqueContacts,
        updatedAt: new Date().toISOString()
      }
    });
  }

  private async recordFailure(error: unknown, failedStep: string, labelName: string | null, expectedElement: string): Promise<void> {
    const current = await this.store.load();
    const serialized = serializeError(error);
    const rawContactCode = String(serialized.details?.contactExportCode || "");
    const recognized = Object.values(CONTACT_EXPORT_ERROR_CODES).includes(rawContactCode as never)
      ? rawContactCode as ContactExportState["diagnostic"]["errorCode"]
      : serialized.code === ERROR_CODES.whatsappNotOpen
        ? CONTACT_EXPORT_ERROR_CODES.whatsappNotReady
        : CONTACT_EXPORT_ERROR_CODES.contactExtractionFailed;
    await this.store.patch({
      status: "error",
      operationId: null,
      diagnostic: {
        status: "red",
        lastSuccessfulStep: current.diagnostic.lastSuccessfulStep,
        failedStep: typeof serialized.details?.stage === "string" ? serialized.details.stage : failedStep,
        labelName,
        strategy: typeof serialized.details?.strategy === "string" ? serialized.details.strategy : current.diagnostic.strategy,
        expectedElement,
        candidateCount: Number(serialized.details?.candidateCount || current.diagnostic.candidateCount || 0),
        processedCount: current.progress?.processed ?? 0,
        reportedCount: serialized.details?.expectedCount == null ? current.diagnostic.reportedCount : Number(serialized.details.expectedCount),
        collectedUniqueContacts: serialized.details?.collectedCount == null ? current.diagnostic.collectedUniqueContacts : Number(serialized.details.collectedCount),
        lastContactCorrelationId: current.diagnostic.lastContactCorrelationId,
        errorCode: recognized,
        errorMessage: serialized.message,
        stack: serialized.stack ?? null,
        technicalDetails: safeTechnicalDetails(serialized.details),
        updatedAt: new Date().toISOString()
      }
    });
  }
}
