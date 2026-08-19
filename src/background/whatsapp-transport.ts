import { ERROR_CODES, ExtensionError, isExtensionErrorCode } from "../shared/errors";
import {
  createInternalRequest,
  INTERNAL_MESSAGE_TYPES,
  type InternalMessageType,
  type InternalRequestMap,
  type InternalResponse,
  type InternalResponseMap
} from "../shared/protocol";
import type { PreflightPurpose } from "../compatibility/types";
import type { WhatsAppPreflightResult } from "../shared/state";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operación cancelada", "AbortError");
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Operación cancelada", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ContentReadinessOptions {
  previousContentInstanceId?: string;
  purpose?: PreflightPurpose;
}

export class WhatsAppTransport {
  private readonly inFlightPreflights = new Map<string, Promise<unknown>>();

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

  private async sendOnce<T extends InternalMessageType>(
    type: T,
    payload: InternalRequestMap[T],
    targetTabId: number,
    validateBoundTab: boolean
  ): Promise<InternalResponseMap[T]> {
    if (validateBoundTab) await this.requireTabId(targetTabId);
    const request = createInternalRequest("service-worker", type, payload);
    let response: InternalResponse<InternalResponseMap[T]> | undefined;
    try {
      response = await chrome.tabs.sendMessage(targetTabId, request) as InternalResponse<InternalResponseMap[T]> | undefined;
    } catch (error) {
      let boundTabExists = false;
      if (validateBoundTab) {
        try { await this.requireTabId(targetTabId); boundTabExists = true; } catch { boundTabExists = false; }
      } else {
        boundTabExists = Boolean(await this.findTab());
      }
      throw new ExtensionError(
        boundTabExists ? ERROR_CODES.interfaceLoading : ERROR_CODES.whatsappNotOpen,
        boundTabExists ? "WhatsApp Web está cambiando de documento y el Content Script todavía no hizo handshake." : "La pestaña de WhatsApp Web vinculada fue cerrada.",
        {
          cause: error,
          details: boundTabExists ? { stage: "content_handshake", transientReceiverUnavailable: true } : undefined
        }
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

  async send<T extends InternalMessageType>(
    type: T,
    payload: InternalRequestMap[T],
    tabId?: number
  ): Promise<InternalResponseMap[T]> {
    const targetTabId = tabId ?? (await this.requireTab()).id;
    if (type !== INTERNAL_MESSAGE_TYPES.whatsappPreflight) {
      return this.sendOnce(type, payload, targetTabId, tabId !== undefined);
    }

    const key = `${targetTabId}:${JSON.stringify(payload)}`;
    const existing = this.inFlightPreflights.get(key);
    if (existing) return existing as Promise<InternalResponseMap[T]>;
    const pending = this.sendOnce(type, payload, targetTabId, tabId !== undefined)
      .finally(() => {
        if (this.inFlightPreflights.get(key) === pending) this.inFlightPreflights.delete(key);
      });
    this.inFlightPreflights.set(key, pending);
    return pending;
  }

  async sendWhenContentReady<T extends InternalMessageType>(
    type: T,
    payload: InternalRequestMap[T],
    tabId: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<InternalResponseMap[T]> {
    throwIfAborted(signal);
    try {
      return await this.send(type, payload, tabId);
    } catch (error) {
      if (!(error instanceof ExtensionError) || error.code !== ERROR_CODES.interfaceLoading) throw error;
      if (signal) await this.waitForContent(tabId, timeoutMs, signal, { purpose: "content_handshake" });
      else await this.waitForContent(tabId, timeoutMs, undefined, { purpose: "content_handshake" });
      throwIfAborted(signal);
      return this.send(type, payload, tabId);
    }
  }

  async waitForContent(
    tabId: number,
    timeoutMs: number,
    signal?: AbortSignal,
    options: ContentReadinessOptions = {}
  ): Promise<WhatsAppPreflightResult> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    let lastResult: WhatsAppPreflightResult | null = null;
    let probes = 0;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      probes += 1;
      try {
        const result = await this.send(INTERNAL_MESSAGE_TYPES.whatsappPreflight, {
          timeoutMs: Math.min(1_000, Math.max(250, deadline - Date.now())),
          level: "lightweight",
          purpose: options.purpose ?? "content_handshake",
          requirements: { needsText: false, needsImages: false }
        }, tabId);
        lastResult = result;
        const generationIsFresh = !options.previousContentInstanceId
          || Boolean(result.contentInstanceId && result.contentInstanceId !== options.previousContentInstanceId);
        if (generationIsFresh && result.documentReady && (result.operational || result.qrDetected)) return result;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() < deadline) await abortableDelay(Math.min(300, Math.max(1, deadline - Date.now())), signal);
    }
    throw new ExtensionError(ERROR_CODES.timeout, "WhatsApp Web no completó el handshake después de abrir la conversación.", {
      cause: lastError,
      details: lastResult ? {
        stage: "content_handshake",
        probes,
        previousGenerationRequired: Boolean(options.previousContentInstanceId),
        freshGenerationObserved: Boolean(!options.previousContentInstanceId || (lastResult.contentInstanceId && lastResult.contentInstanceId !== options.previousContentInstanceId)),
        lastStatus: lastResult.status,
        pageDetected: lastResult.pageDetected,
        documentReady: lastResult.documentReady,
        sessionReady: lastResult.sessionReady,
        mainInterfaceReady: lastResult.mainInterfaceReady,
        qrDetected: lastResult.qrDetected,
        overallStatus: lastResult.overallStatus
      } : { stage: "content_handshake", probes, lastStatus: "no_response", previousGenerationRequired: Boolean(options.previousContentInstanceId) }
    });
  }
}
