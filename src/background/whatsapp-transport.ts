import { ERROR_CODES, ExtensionError, isExtensionErrorCode } from "../shared/errors";
import {
  createInternalRequest,
  INTERNAL_MESSAGE_TYPES,
  type InternalMessageType,
  type InternalRequestMap,
  type InternalResponse,
  type InternalResponseMap
} from "../shared/protocol";
import type { WhatsAppPreflightResult } from "../shared/state";

export class WhatsAppTransport {
  async findTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
    return tabs.find((tab) => typeof tab.id === "number") ?? null;
  }

  async requireTab(): Promise<chrome.tabs.Tab & { id: number }> {
    const tab = await this.findTab();
    if (!tab || typeof tab.id !== "number") {
      throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "WhatsApp Web no está abierto en ninguna pestaña.");
    }
    return tab as chrome.tabs.Tab & { id: number };
  }

  async send<T extends InternalMessageType>(
    type: T,
    payload: InternalRequestMap[T],
    tabId?: number
  ): Promise<InternalResponseMap[T]> {
    const targetTabId = tabId ?? (await this.requireTab()).id;
    const request = createInternalRequest("service-worker", type, payload);
    let response: InternalResponse<InternalResponseMap[T]> | undefined;
    try {
      response = await chrome.tabs.sendMessage(targetTabId, request) as InternalResponse<InternalResponseMap[T]> | undefined;
    } catch (error) {
      const tab = await this.findTab();
      throw new ExtensionError(
        tab ? ERROR_CODES.interfaceLoading : ERROR_CODES.whatsappNotOpen,
        tab ? "WhatsApp Web se está recargando o su Content Script todavía no responde." : "La pestaña de WhatsApp Web fue cerrada.",
        { cause: error }
      );
    }
    if (!response?.ok || response.data === undefined) {
      throw new ExtensionError(
        isExtensionErrorCode(response?.error?.code) ? response.error.code : ERROR_CODES.internal,
        response?.error?.message || "WhatsApp Web no respondió.",
        {
          recoverable: response?.error?.recoverable ?? true,
          details: { remoteErrorCode: response?.error?.code, ...response?.error?.details }
        }
      );
    }
    return response.data;
  }

  async waitForContent(tabId: number, timeoutMs: number): Promise<WhatsAppPreflightResult> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const result = await this.send(INTERNAL_MESSAGE_TYPES.whatsappPreflight, { timeoutMs: 1_000 }, tabId);
        if (result.documentReady && (result.operational || result.qrDetected || result.status === "incompatible")) return result;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
    }
    throw new ExtensionError(ERROR_CODES.timeout, "WhatsApp Web no quedó listo después de abrir la conversación.", { cause: lastError });
  }
}
