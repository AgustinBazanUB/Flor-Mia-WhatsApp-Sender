import {
  buildMessageContactPreview,
  calculateMessageContactProgress,
  MESSAGE_CONTACT_ERROR_CODES,
  pendingMessageContactItems,
  recomputeMessageContactSummary,
  type MessageContactErrorCode,
  type MessageContactPreviewItem,
  type MessageContactWorkflowState,
  type MessageSearchOptions
} from "../contact-export/add-contacts-by-message";
import { ContactExportStore } from "../contact-export/contact-export-store";
import { MessageContactStore } from "../contact-export/message-contact-store";
import type { MessageContactRequestMap } from "../contact-export/message-contact-protocol";
import {
  assignWhatsAppChatToLabel,
  refreshWhatsAppLabelMemberCount,
  searchWhatsAppMessagesMainWorld
} from "../contact-export/whatsapp-message-search-main-world";
import { resolveWhatsAppLidsInMainWorld } from "../contact-export/whatsapp-main-world-resolver";
import type { WhatsAppLabelInfo } from "../contact-export/types";
import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { createId } from "../shared/ids";
import type { WhatsAppTransport } from "./whatsapp-transport";

const MAX_ASSIGNMENT_ATTEMPTS = 2;

function errorCode(value: string | null | undefined, fallback: MessageContactErrorCode): MessageContactErrorCode {
  return Object.values(MESSAGE_CONTACT_ERROR_CODES).includes(value as MessageContactErrorCode)
    ? value as MessageContactErrorCode
    : fallback;
}

export class MessageContactRuntime {
  private assignmentPromise: Promise<MessageContactWorkflowState> | null = null;

  constructor(
    private readonly store: MessageContactStore,
    private readonly contactExportStore: ContactExportStore,
    private readonly transport: WhatsAppTransport
  ) {}

  getState(): Promise<MessageContactWorkflowState> {
    return this.store.load();
  }

  reset(): Promise<MessageContactWorkflowState> {
    if (this.assignmentPromise) throw new ExtensionError(ERROR_CODES.invalidInput, "Pausá o cancelá el agregado antes de limpiar la búsqueda.");
    return this.store.reset();
  }

  async search(payload: MessageContactRequestMap["MESSAGE_CONTACT_SEARCH"]): Promise<MessageContactWorkflowState> {
    if (this.assignmentPromise) throw new ExtensionError(ERROR_CODES.invalidInput, "Hay un agregado de contactos en curso.");
    const searchText = String(payload.searchText ?? "").normalize("NFC").trim();
    if (!searchText) throw new ExtensionError(ERROR_CODES.invalidInput, "Ingresá una frase para buscar.");
    if (searchText.length > 500) throw new ExtensionError(ERROR_CODES.invalidInput, "La frase de búsqueda no puede superar 500 caracteres.");
    const targetLabel = payload.targetLabel;
    if (!targetLabel?.id || !targetLabel.name?.trim()) throw new ExtensionError(ERROR_CODES.invalidInput, "Seleccioná una lista destino válida.");
    const options: MessageSearchOptions = {
      searchText,
      mode: payload.mode === "exact" ? "exact" : "contains",
      inboundOnly: payload.inboundOnly !== false,
      excludeGroups: payload.excludeGroups !== false,
      excludeCommunities: payload.excludeCommunities !== false,
      excludeChannels: payload.excludeChannels !== false
    };
    const operationId = createId("message-contact-search");
    await this.store.save({
      ...(await this.store.load()),
      status: "searching",
      operationId,
      targetLabel,
      targetContactCountBefore: targetLabel.countHint,
      targetContactCountAfter: null,
      search: options,
      items: [],
      summary: { messagesFound: 0, uniqueContacts: 0, alreadyInList: 0, newContacts: 0, unresolved: 0, added: 0, failed: 0 },
      progress: null,
      metrics: null,
      pauseRequested: false,
      cancelRequested: false,
      diagnostic: {
        status: "unknown",
        currentStep: "Global Search",
        lastSuccessfulStep: "target_list_selected",
        failedStep: null,
        lastSuccessfulContactId: null,
        errorCode: null,
        errorMessage: null,
        strategy: "main-world-global-msg-search",
        updatedAt: new Date().toISOString()
      }
    });

    const tab = await this.transport.requireTab();
    try {
      const snapshot = await searchWhatsAppMessagesMainWorld(tab.id, targetLabel, options);
      if (!snapshot?.supported) {
        const code = snapshot?.reason?.includes("Msg.search")
          ? MESSAGE_CONTACT_ERROR_CODES.globalSearchNotAvailable
          : MESSAGE_CONTACT_ERROR_CODES.whatsappStructureChanged;
        await this.fail(code, snapshot?.reason || "No se pudo acceder a la búsqueda global estructurada.", "Global Search");
        throw new ExtensionError(ERROR_CODES.elementNotFound, "La búsqueda global de WhatsApp no está disponible con la estructura actual.", {
          recoverable: true,
          details: { messageContactCode: code, stage: "Global Search", strategy: "main-world-global-msg-search" }
        });
      }

      const unresolvedLids = snapshot.results
        .filter((result) => !result.phoneCandidate && /^\d{8,20}@lid$/i.test(result.contactId ?? result.chatId ?? ""))
        .map((result) => String(result.contactId ?? result.chatId))
        .filter((id, index, all) => all.indexOf(id) === index);
      if (unresolvedLids.length) {
        const hydrated = await resolveWhatsAppLidsInMainWorld(tab.id, unresolvedLids);
        for (const result of snapshot.results) {
          const id = String(result.contactId ?? result.chatId ?? "");
          if (!result.phoneCandidate && hydrated.phones[id]) result.phoneCandidate = hydrated.phones[id];
        }
      }

      const preview = buildMessageContactPreview(snapshot.results, options);
      const now = new Date().toISOString();
      return this.store.patch({
        status: "preview",
        operationId: null,
        targetContactCountBefore: snapshot.targetLabelMemberCount ?? targetLabel.countHint,
        items: preview.items,
        summary: preview.summary,
        metrics: {
          ...snapshot.metrics,
          directionUnknown: Math.max(snapshot.metrics.directionUnknown, preview.directionUnknown),
          excludedNonContacts: Math.max(snapshot.metrics.excludedNonContacts, preview.excludedNonContacts)
        },
        diagnostic: {
          status: "green",
          currentStep: "Preview",
          lastSuccessfulStep: "search_preview_ready",
          failedStep: null,
          lastSuccessfulContactId: null,
          errorCode: null,
          errorMessage: null,
          strategy: "main-world-global-msg-search+local-deterministic-validation",
          updatedAt: now
        }
      });
    } catch (error) {
      const latest = await this.store.load();
      if (latest.status !== "error") {
        await this.fail(MESSAGE_CONTACT_ERROR_CODES.searchResultParseFailed, error instanceof Error ? error.message : "No se pudo procesar la búsqueda.", "Global Search");
      }
      throw error;
    }
  }

  async startAssignment(): Promise<MessageContactWorkflowState> {
    if (this.assignmentPromise) return this.assignmentPromise;
    const current = await this.store.load();
    if (current.status !== "preview" && current.status !== "paused") {
      throw new ExtensionError(ERROR_CODES.invalidInput, "Primero realizá una búsqueda y revisá la vista previa.");
    }
    if (!current.targetLabel) throw new ExtensionError(ERROR_CODES.invalidInput, "La lista destino ya no está disponible.");
    if (!pendingMessageContactItems(current.items).length) {
      return this.completeAndRefresh(current.targetLabel);
    }
    await this.store.patch({
      status: "assigning",
      operationId: current.operationId ?? createId("message-contact-assign"),
      pauseRequested: false,
      cancelRequested: false,
      progress: calculateMessageContactProgress(current.items),
      diagnostic: {
        ...current.diagnostic,
        status: "unknown",
        currentStep: "List Assignment",
        lastSuccessfulStep: "assignment_confirmed_by_user",
        failedStep: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date().toISOString()
      }
    });
    this.assignmentPromise = this.runAssignmentLoop().finally(() => { this.assignmentPromise = null; });
    return this.assignmentPromise;
  }

  async pause(): Promise<MessageContactWorkflowState> {
    const current = await this.store.load();
    if (!this.assignmentPromise || !["assigning", "pausing"].includes(current.status)) return current;
    return this.store.patch({
      status: "pausing",
      pauseRequested: true,
      diagnostic: { ...current.diagnostic, currentStep: "Pausing", updatedAt: new Date().toISOString() }
    });
  }

  async resume(): Promise<MessageContactWorkflowState> {
    const current = await this.store.load();
    if (current.status !== "paused") return current;
    return this.startAssignment();
  }

  async cancel(): Promise<MessageContactWorkflowState> {
    const current = await this.store.load();
    if (!["assigning", "pausing", "paused", "preview", "searching"].includes(current.status)) return current;
    return this.store.patch({
      status: "cancelled",
      cancelRequested: true,
      pauseRequested: false,
      operationId: null,
      diagnostic: {
        ...current.diagnostic,
        status: "green",
        currentStep: "Cancelled",
        lastSuccessfulStep: "cancelled_by_user",
        failedStep: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date().toISOString()
      }
    });
  }

  async refreshList(): Promise<MessageContactWorkflowState> {
    const current = await this.store.load();
    if (!current.targetLabel) throw new ExtensionError(ERROR_CODES.invalidInput, "Elegí una lista antes de actualizarla.");
    const tab = await this.transport.requireTab();
    const refreshed = await refreshWhatsAppLabelMemberCount(tab.id, current.targetLabel);
    if (!refreshed.supported || !refreshed.found || refreshed.memberCount == null) {
      await this.fail(MESSAGE_CONTACT_ERROR_CODES.listMembershipCheckFailed, "No se pudo volver a leer la lista destino.", "Refresh List");
      throw new ExtensionError(ERROR_CODES.elementNotFound, "WhatsApp no permitió confirmar el nuevo total de la lista.");
    }
    await this.syncContactExportLabelCount(current.targetLabel, refreshed.memberCount);
    return this.store.patch({
      targetContactCountAfter: refreshed.memberCount,
      diagnostic: {
        ...current.diagnostic,
        status: "green",
        currentStep: "Ready for Export",
        lastSuccessfulStep: "target_list_refreshed",
        failedStep: null,
        errorCode: null,
        errorMessage: null,
        strategy: refreshed.strategy,
        updatedAt: new Date().toISOString()
      }
    });
  }

  private async runAssignmentLoop(): Promise<MessageContactWorkflowState> {
    const tab = await this.transport.requireTab();
    while (true) {
      const current = await this.store.load();
      if (current.cancelRequested || current.status === "cancelled") return current;
      if (current.pauseRequested || current.status === "pausing") {
        return this.store.patch({ status: "paused", operationId: null, progress: calculateMessageContactProgress(current.items) });
      }
      if (!current.targetLabel) throw new ExtensionError(ERROR_CODES.invalidInput, "La lista destino ya no está disponible.");
      const next = pendingMessageContactItems(current.items)[0];
      if (!next) return this.completeAndRefresh(current.targetLabel);

      const addingItems = current.items.map((item) => item.id === next.id
        ? { ...item, assignmentStatus: "ADDING" as const, attempts: item.attempts + 1, errorCode: null, errorMessage: null }
        : item);
      await this.store.patch({
        status: "assigning",
        items: addingItems,
        progress: calculateMessageContactProgress(addingItems),
        diagnostic: { ...current.diagnostic, currentStep: "List Assignment", updatedAt: new Date().toISOString() }
      });

      let result = await assignWhatsAppChatToLabel(tab.id, current.targetLabel, next.chatId);
      let attempts = addingItems.find((item) => item.id === next.id)?.attempts ?? 1;
      while (result.status === "FAILED" && attempts < MAX_ASSIGNMENT_ATTEMPTS) {
        const retryable = result.errorCode === MESSAGE_CONTACT_ERROR_CODES.listAssignmentFailed
          || result.errorCode === MESSAGE_CONTACT_ERROR_CODES.listAssignmentNotConfirmed;
        if (!retryable) break;
        attempts += 1;
        result = await assignWhatsAppChatToLabel(tab.id, current.targetLabel, next.chatId);
      }

      const afterAttempt = await this.store.load();
      const updatedItems = afterAttempt.items.map((item): MessageContactPreviewItem => {
        if (item.id !== next.id) return item;
        if (result.status === "ADDED") {
          return { ...item, assignmentStatus: "ADDED", attempts, errorCode: null, errorMessage: null };
        }
        if (result.status === "ALREADY_IN_LIST") {
          return { ...item, assignmentStatus: "ALREADY_IN_LIST", attempts, errorCode: null, errorMessage: null };
        }
        return {
          ...item,
          assignmentStatus: "FAILED",
          attempts,
          errorCode: errorCode(result.errorCode, MESSAGE_CONTACT_ERROR_CODES.listAssignmentFailed),
          errorMessage: String(result.errorMessage || "No se pudo confirmar la asignación.").slice(0, 300)
        };
      });
      const summary = recomputeMessageContactSummary(updatedItems, afterAttempt.summary.messagesFound);
      const successful = result.status === "ADDED" || result.status === "ALREADY_IN_LIST";
      await this.store.patch({
        items: updatedItems,
        summary,
        targetContactCountAfter: result.memberCount ?? afterAttempt.targetContactCountAfter,
        progress: calculateMessageContactProgress(updatedItems),
        diagnostic: {
          ...afterAttempt.diagnostic,
          status: successful ? "unknown" : afterAttempt.diagnostic.status,
          currentStep: "List Assignment",
          lastSuccessfulStep: successful ? "contact_assignment_verified" : afterAttempt.diagnostic.lastSuccessfulStep,
          lastSuccessfulContactId: successful ? next.id : afterAttempt.diagnostic.lastSuccessfulContactId,
          errorCode: successful ? null : errorCode(result.errorCode, MESSAGE_CONTACT_ERROR_CODES.listAssignmentFailed),
          errorMessage: successful ? null : String(result.errorMessage || "No se pudo confirmar la asignación.").slice(0, 300),
          strategy: result.strategy,
          updatedAt: new Date().toISOString()
        }
      });
    }
  }

  private async completeAndRefresh(targetLabel: WhatsAppLabelInfo): Promise<MessageContactWorkflowState> {
    const tab = await this.transport.requireTab();
    const refreshed = await refreshWhatsAppLabelMemberCount(tab.id, targetLabel);
    const current = await this.store.load();
    const memberCount = refreshed.supported && refreshed.found ? refreshed.memberCount : current.targetContactCountAfter;
    if (memberCount != null) await this.syncContactExportLabelCount(targetLabel, memberCount);
    const summary = recomputeMessageContactSummary(current.items, current.summary.messagesFound);
    return this.store.patch({
      status: "completed",
      operationId: null,
      targetContactCountAfter: memberCount,
      summary,
      progress: calculateMessageContactProgress(current.items),
      diagnostic: {
        ...current.diagnostic,
        status: summary.failed > 0 ? "red" : "green",
        currentStep: "Completed",
        lastSuccessfulStep: "assignment_batch_completed",
        failedStep: summary.failed > 0 ? "List Assignment" : null,
        errorCode: summary.failed > 0 ? MESSAGE_CONTACT_ERROR_CODES.listAssignmentFailed : null,
        errorMessage: summary.failed > 0 ? "Uno o más contactos no pudieron confirmarse en la lista." : null,
        strategy: refreshed.strategy || current.diagnostic.strategy,
        updatedAt: new Date().toISOString()
      }
    });
  }

  private async syncContactExportLabelCount(targetLabel: WhatsAppLabelInfo, count: number): Promise<void> {
    const exportState = await this.contactExportStore.load();
    const labels = exportState.labels.map((label) => label.id === targetLabel.id
      ? { ...label, countHint: count, countHintStrategy: "main-world-refresh-after-message-assignment" }
      : label);
    await this.contactExportStore.patch({ labels });
  }

  private async fail(code: MessageContactErrorCode, message: string, step: string): Promise<MessageContactWorkflowState> {
    const current = await this.store.load();
    return this.store.patch({
      status: "error",
      operationId: null,
      diagnostic: {
        ...current.diagnostic,
        status: "red",
        currentStep: step,
        failedStep: step,
        errorCode: code,
        errorMessage: message.slice(0, 500),
        updatedAt: new Date().toISOString()
      }
    });
  }
}
