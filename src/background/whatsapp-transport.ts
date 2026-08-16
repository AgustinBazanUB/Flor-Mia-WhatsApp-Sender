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

  async requireTabId(tabId: number): Promise<chrome.tabs.Tab & { id: number }> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (typeof tab.id !== "number" || !tab.url?.startsWith("https://web.whatsapp.com/")) throw new Error("invalid whatsapp tab");
      return tab as chrome.tabs.Tab & { id: number };
    } catch (error) {
      throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "La pestaña de WhatsApp vinculada al contacto fue cerrada.", { cause: error });
    }
  }

  async send<T extends InternalMessageType>(
    type: T,
    payload: InternalRequestMap[T],
    tabId?: number
  ): Promise<InternalResponseMap[T]> {
    const targetTabId = tabId ?? (await this.requireTab()).id;
    if (tabId !== undefined) await this.requireTabId(targetTabId);
    const request = createInternalRequest("service-worker", type, payload);
    let response: InternalResponse<InternalResponseMap[T]> | undefined;
    try {
      response = await chrome.tabs.sendMessage(targetTabId, request) as InternalResponse<InternalResponseMap[T]> | undefined;
    } catch (error) {
      let boundTabExists = false;
      if (tabId !== undefined) {
        try { await this.requireTabId(targetTabId); boundTabExists = true; } catch { boundTabExists = false; }
      } else {
        boundTabExists = Boolean(await this.findTab());
      }
      throw new ExtensionError(
        boundTabExists ? ERROR_CODES.interfaceLoading : ERROR_CODES.whatsappNotOpen,
        boundTabExists ? "WhatsApp Web se está recargando o su Content Script todavía no responde." : "La pestaña de WhatsApp Web vinculada fue cerrada.",
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

  async sendWhenContentReady<T extends InternalMessageType>(
    type: T,
    payload: InternalRequestMap[T],
    tabId: number,
    timeoutMs: number
  ): Promise<InternalResponseMap[T]> {
    try {
      return await this.send(type, payload, tabId);
    } catch (error) {
      if (!(error instanceof ExtensionError) || error.code !== ERROR_CODES.interfaceLoading) throw error;
      await this.waitForContent(tabId, timeoutMs);
      return this.send(type, payload, tabId);
    }
  }

  async waitForContent(tabId: number, timeoutMs: number): Promise<WhatsAppPreflightResult> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const result = await this.send(INTERNAL_MESSAGE_TYPES.whatsappPreflight, { timeoutMs: 1_000 }, tabId);
        if (result.documentReady && (result.operational || result.qrDetected)) return result;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
    }
    throw new ExtensionError(ERROR_CODES.timeout, "WhatsApp Web no quedó listo después de abrir la conversación.", { cause: lastError });
  }
}
