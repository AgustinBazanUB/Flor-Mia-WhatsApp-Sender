import { createId } from "../shared/ids";
import { ERROR_CODES, ExtensionError, serializeError } from "../shared/errors";
import { INTERNAL_MESSAGE_TYPES, type InternalRequestMap } from "../shared/protocol";
import { deduplicateContactCandidates } from "../contact-export/contact-deduplicator";
import { ContactExportStore } from "../contact-export/contact-export-store";
import {
  CONTACT_EXPORT_ERROR_CODES,
  type ContactExportProgress,
  type ContactExportState
} from "../contact-export/types";
import { WhatsAppTransport } from "./whatsapp-transport";

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
        lastContactCorrelationId: null,
        errorCode: null,
        errorMessage: null,
        stack: null,
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
          lastContactCorrelationId: null,
          errorCode: null,
          errorMessage: null,
          stack: null,
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
        expectedElement: "Listado de chats/contactos de la etiqueta",
        errorCode: null,
        errorMessage: null,
        stack: null,
        updatedAt: new Date().toISOString()
      }
    });

    const tab = await this.transport.requireTab();
    try {
      const result = await this.transport.sendWhenContentReady(
        INTERNAL_MESSAGE_TYPES.whatsappContactExportAnalyze,
        { operationId, labels },
        tab.id,
        Math.max(60_000, labels.length * 60_000)
      );
      const deduplicated = deduplicateContactCandidates(result.candidates);
      return this.store.patch({
        status: "completed",
        operationId: null,
        contacts: deduplicated.contacts,
        problems: deduplicated.problems,
        summary: deduplicated.summary,
        progress: {
          operationId,
          processed: deduplicated.summary.found,
          totalHint: deduplicated.summary.found,
          percent: 100,
          currentLabel: labels.at(-1)?.name ?? null,
          labelIndex: labels.length,
          totalLabels: labels.length,
          currentContact: deduplicated.summary.found,
          updatedAt: new Date().toISOString()
        },
        diagnostic: {
          ...deduplicated.diagnostic,
          status: "green",
          lastSuccessfulStep: "contact_export_analysis_completed",
          labelName: labels.at(-1)?.name ?? null,
          strategy: result.strategy,
          candidateCount: result.candidates.length,
          processedCount: deduplicated.summary.found,
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
      await this.recordFailure(error, "analyze_contacts", latest.progress?.currentLabel ?? null, "Listado de chats/contactos de la etiqueta");
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
    return this.store.patch({ progress });
  }

  private async recordFailure(error: unknown, failedStep: string, labelName: string | null, expectedElement: string): Promise<void> {
    const current = await this.store.load();
    const serialized = serializeError(error);
    const contactCode = String(serialized.details?.contactExportCode || "") as keyof typeof CONTACT_EXPORT_ERROR_CODES;
    const recognized = Object.values(CONTACT_EXPORT_ERROR_CODES).includes(contactCode as never)
      ? contactCode as ContactExportState["diagnostic"]["errorCode"]
      : serialized.code === ERROR_CODES.whatsappNotOpen
        ? CONTACT_EXPORT_ERROR_CODES.whatsappNotReady
        : CONTACT_EXPORT_ERROR_CODES.contactExtractionFailed;
    await this.store.patch({
      status: "error",
      operationId: null,
      diagnostic: {
        status: "red",
        lastSuccessfulStep: current.diagnostic.lastSuccessfulStep,
        failedStep,
        labelName,
        strategy: typeof serialized.details?.strategy === "string" ? serialized.details.strategy : current.diagnostic.strategy,
        expectedElement,
        candidateCount: Number(serialized.details?.candidateCount || current.diagnostic.candidateCount || 0),
        processedCount: current.progress?.processed ?? 0,
        lastContactCorrelationId: current.diagnostic.lastContactCorrelationId,
        errorCode: recognized,
        errorMessage: serialized.message,
        stack: serialized.stack ?? null,
        updatedAt: new Date().toISOString()
      }
    });
  }
}
