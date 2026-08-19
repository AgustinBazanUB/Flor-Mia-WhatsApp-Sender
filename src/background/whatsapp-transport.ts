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

const PROBE_BACKOFF_MS = [250, 400, 650, 1_000, 1_500] as const;

type TabLifecycleChangeInfo = {
  status?: chrome.tabs.Tab["status"];
  url?: string;
};

type ContentTransportFailureKind =
  | "RECEIVING_END_NOT_READY"
  | "MESSAGE_PORT_CLOSED_DURING_NAVIGATION"
  | "PERMISSION_DENIED"
  | "UNEXPECTED_RUNTIME_ERROR";

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

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new DOMException("Operación cancelada", "AbortError")));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function classifyContentTransportFailure(error: unknown): ContentTransportFailureKind {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("receiving end does not exist") || message.includes("could not establish connection")) {
    return "RECEIVING_END_NOT_READY";
  }
  if (message.includes("message port closed") || message.includes("the port closed")) {
    return "MESSAGE_PORT_CLOSED_DURING_NAVIGATION";
  }
  if (message.includes("cannot access contents of url") || message.includes("missing host permission") || message.includes("permission denied")) {
    return "PERMISSION_DENIED";
  }
  return "UNEXPECTED_RUNTIME_ERROR";
}

function transientContentFailure(kind: ContentTransportFailureKind): boolean {
  return kind === "RECEIVING_END_NOT_READY" || kind === "MESSAGE_PORT_CLOSED_DURING_NAVIGATION";
}

function isExpectedConversationUrl(url: string | undefined, expectedPhoneDigits?: string): boolean {
  if (!url?.startsWith("https://web.whatsapp.com/")) return false;
  if (!expectedPhoneDigits) return true;
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/send" && parsed.searchParams.get("phone") === expectedPhoneDigits;
  } catch {
    return false;
  }
}

export interface ContentReadinessOptions {
  previousContentInstanceId?: string;
  purpose?: PreflightPurpose;
  navigationRequestId?: string;
  expectedContentInstanceId?: string;
}

export interface NavigationLifecycleOptions {
  expectedPhoneDigits?: string;
  navigationRequestId?: string;
  waitForComplete?: boolean;
}

export interface NavigationLifecycleResult {
  observedAt: string;
  loadingAt: string | null;
  completeAt: string | null;
  finalStatus: chrome.tabs.Tab["status"] | null;
  urlMatched: boolean;
}

interface ReadinessDiagnostics {
  probes: number;
  transientProbeErrors: number;
  lastTransientError: string | null;
  freshGenerationObserved: boolean;
}

type ReadinessMode = "legacy" | "handshake" | "semantic";

export class WhatsAppTransport {
  private readonly inFlightPreflights = new Map<string, Promise<unknown>>();
  private readonly inFlightHandshakes = new Map<string, Promise<WhatsAppPreflightResult>>();

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
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "La pestaña de WhatsApp vinculada al contacto fue cerrada.", { cause: error });
    }
    if (typeof tab.id !== "number") {
      throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "La pestaña de WhatsApp vinculada al contacto ya no existe.");
    }
    if (!tab.url?.startsWith("https://web.whatsapp.com/")) {
      throw new ExtensionError(ERROR_CODES.protocolError, "La pestaña vinculada dejó de pertenecer a WhatsApp Web.", {
        recoverable: false,
        details: { probeErrorKind: "WRONG_ORIGIN" }
      });
    }
    return tab as chrome.tabs.Tab & { id: number };
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
      if (validateBoundTab) {
        await this.requireTabId(targetTabId);
      } else if (!(await this.findTab())) {
        throw new ExtensionError(ERROR_CODES.whatsappNotOpen, "La pestaña de WhatsApp Web vinculada fue cerrada.", { cause: error });
      }
      const kind = classifyContentTransportFailure(error);
      if (transientContentFailure(kind)) {
        throw new ExtensionError(
          ERROR_CODES.interfaceLoading,
          "WhatsApp Web está cambiando de documento y el Content Script todavía no hizo handshake.",
          {
            cause: error,
            details: { stage: "content_handshake", transientContentError: kind }
          }
        );
      }
      if (kind === "PERMISSION_DENIED") {
        throw new ExtensionError(ERROR_CODES.protocolError, "Chrome bloqueó el acceso de la extensión a WhatsApp Web.", {
          recoverable: false,
          cause: error,
          details: { stage: "content_handshake", probeErrorKind: kind }
        });
      }
      throw new ExtensionError(ERROR_CODES.internal, "Chrome devolvió un error inesperado al contactar WhatsApp Web.", {
        recoverable: false,
        cause: error,
        details: { stage: "content_handshake", probeErrorKind: kind }
      });
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
      if (signal) await this.waitForContent(tabId, timeoutMs, signal);
      else await this.waitForContent(tabId, timeoutMs);
      throwIfAborted(signal);
      return this.send(type, payload, tabId);
    }
  }

  async waitForNavigationLifecycle(
    tabId: number,
    timeoutMs: number,
    signal?: AbortSignal,
    options: NavigationLifecycleOptions = {}
  ): Promise<NavigationLifecycleResult> {
    throwIfAborted(signal);
    const timeout = Math.max(1, timeoutMs);
    return new Promise<NavigationLifecycleResult>((resolve, reject) => {
      let settled = false;
      let loadingAt: string | null = null;
      let completeAt: string | null = null;
      let lastStatus: chrome.tabs.Tab["status"] | null = null;
      let urlMatched = false;

      const cleanup = (): void => {
        globalThis.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        chrome.tabs.onUpdated?.removeListener(onUpdated);
        chrome.tabs.onRemoved?.removeListener(onRemoved);
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const inspect = (changeInfo: TabLifecycleChangeInfo, tab: chrome.tabs.Tab): void => {
        const now = new Date().toISOString();
        const status = changeInfo.status ?? tab.status ?? null;
        if (status === "loading" && !loadingAt) loadingAt = now;
        if (status === "complete" && !completeAt) completeAt = now;
        lastStatus = status;
        const candidateUrl = changeInfo.url ?? tab.url;
        if (isExpectedConversationUrl(candidateUrl, options.expectedPhoneDigits)) urlMatched = true;
        if (!urlMatched) return;
        if (options.waitForComplete && status !== "complete") return;
        finish(() => resolve({
          observedAt: now,
          loadingAt,
          completeAt,
          finalStatus: lastStatus,
          urlMatched: true
        }));
      };
      const onUpdated = (updatedTabId: number, changeInfo: TabLifecycleChangeInfo, tab: chrome.tabs.Tab): void => {
        if (updatedTabId !== tabId) return;
        inspect(changeInfo, tab);
      };
      const onRemoved = (removedTabId: number): void => {
        if (removedTabId !== tabId) return;
        finish(() => reject(new ExtensionError(ERROR_CODES.whatsappNotOpen, "La pestaña de WhatsApp se cerró durante la navegación.", {
          details: { stage: "navigation", navigationRequestId: options.navigationRequestId }
        })));
      };
      const onAbort = (): void => finish(() => reject(new DOMException("Operación cancelada", "AbortError")));
      const timer = globalThis.setTimeout(() => {
        finish(() => reject(new ExtensionError(ERROR_CODES.timeout, "WhatsApp no confirmó el inicio de la navegación solicitada.", {
          details: {
            stage: "navigation",
            navigationRequestId: options.navigationRequestId,
            tabStatus: lastStatus,
            urlMatched,
            loadingObserved: Boolean(loadingAt),
            completeObserved: Boolean(completeAt)
          }
        })));
      }, timeout);

      chrome.tabs.onUpdated?.addListener(onUpdated);
      chrome.tabs.onRemoved?.addListener(onRemoved);
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.requireTabId(tabId).then(
        (tab) => inspect({}, tab),
        (error) => finish(() => reject(error))
      );
    });
  }

  private async waitForProbeOpportunity(tabId: number, delayMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (typeof chrome === "undefined" || !chrome.tabs?.onUpdated?.addListener) {
      await abortableDelay(delayMs, signal);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        globalThis.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved?.removeListener(onRemoved);
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onUpdated = (updatedTabId: number, changeInfo: TabLifecycleChangeInfo): void => {
        if (updatedTabId !== tabId || (!changeInfo.status && !changeInfo.url)) return;
        finish(resolve);
      };
      const onRemoved = (removedTabId: number): void => {
        if (removedTabId !== tabId) return;
        finish(() => reject(new ExtensionError(ERROR_CODES.whatsappNotOpen, "La pestaña de WhatsApp se cerró durante el handshake.")));
      };
      const onAbort = (): void => finish(() => reject(new DOMException("Operación cancelada", "AbortError")));
      const timer = globalThis.setTimeout(() => finish(resolve), delayMs);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved?.addListener(onRemoved);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async finalTabDiagnostics(tabId: number, expectedPhoneDigits?: string): Promise<{ tabStatus: chrome.tabs.Tab["status"] | null; urlMatched: boolean }> {
    try {
      const tab = await this.requireTabId(tabId);
      return { tabStatus: tab.status ?? null, urlMatched: isExpectedConversationUrl(tab.url, expectedPhoneDigits) };
    } catch {
      return { tabStatus: null, urlMatched: false };
    }
  }

  private async waitForReadiness(
    tabId: number,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    options: ContentReadinessOptions,
    mode: ReadinessMode
  ): Promise<WhatsAppPreflightResult> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let lastError: unknown;
    let lastResult: WhatsAppPreflightResult | null = null;
    const diagnostics: ReadinessDiagnostics = {
      probes: 0,
      transientProbeErrors: 0,
      lastTransientError: null,
      freshGenerationObserved: false
    };
    let backoffIndex = 0;

    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const remaining = Math.max(1, deadline - Date.now());
      diagnostics.probes += 1;
      try {
        const probeTimeout = mode === "handshake" ? 250 : mode === "semantic" ? 1_500 : 1_000;
        const purpose: PreflightPurpose = mode === "semantic"
          ? "semantic_ready"
          : options.purpose ?? "content_handshake";
        const result = await withAbort(this.send(INTERNAL_MESSAGE_TYPES.whatsappPreflight, {
          timeoutMs: Math.min(probeTimeout, remaining),
          level: "lightweight",
          purpose,
          requirements: { needsText: false, needsImages: false }
        }, tabId), signal);
        lastResult = result;

        const freshGeneration = !options.previousContentInstanceId
          || Boolean(result.contentInstanceId && result.contentInstanceId !== options.previousContentInstanceId);
        const expectedGeneration = !options.expectedContentInstanceId
          || result.contentInstanceId === options.expectedContentInstanceId;
        diagnostics.freshGenerationObserved ||= freshGeneration;

        if (!freshGeneration) {
          diagnostics.transientProbeErrors += 1;
          diagnostics.lastTransientError = "STALE_CONTENT_GENERATION";
        } else if (mode === "handshake" && expectedGeneration && result.pageDetected && result.contentScriptConnected) {
          return result;
        } else if (mode !== "handshake" && expectedGeneration && result.documentReady && (result.operational || result.qrDetected)) {
          return result;
        } else {
          diagnostics.transientProbeErrors += 1;
          diagnostics.lastTransientError = result.status === "loading" ? "TAB_LOADING" : "SEMANTIC_SURFACE_NOT_READY";
        }
      } catch (error) {
        lastError = error;
        if (!(error instanceof ExtensionError) || error.code !== ERROR_CODES.interfaceLoading) throw error;
        diagnostics.transientProbeErrors += 1;
        diagnostics.lastTransientError = typeof error.details?.transientContentError === "string"
          ? error.details.transientContentError
          : "RECEIVING_END_NOT_READY";
      }

      if (Date.now() >= deadline) break;
      const delay = PROBE_BACKOFF_MS[Math.min(backoffIndex, PROBE_BACKOFF_MS.length - 1)]!;
      backoffIndex += 1;
      await this.waitForProbeOpportunity(tabId, Math.min(delay, Math.max(1, deadline - Date.now())), signal);
    }

    const finalTab = await this.finalTabDiagnostics(tabId);
    const stage = mode === "semantic" ? "semantic_ready" : "content_handshake";
    throw new ExtensionError(ERROR_CODES.timeout, mode === "semantic"
      ? "WhatsApp Web no terminó de preparar la conversación dentro del tiempo esperado."
      : "WhatsApp Web no completó el handshake después de abrir la conversación.", {
      cause: lastError,
      details: {
        stage,
        navigationRequestId: options.navigationRequestId,
        probeCount: diagnostics.probes,
        transientProbeErrors: diagnostics.transientProbeErrors,
        lastTransientError: diagnostics.lastTransientError,
        previousGenerationRequired: Boolean(options.previousContentInstanceId),
        contentGenerationChanged: diagnostics.freshGenerationObserved,
        expectedGenerationMatched: !options.expectedContentInstanceId || lastResult?.contentInstanceId === options.expectedContentInstanceId,
        tabStatus: finalTab.tabStatus,
        ...(lastResult ? {
          lastStatus: lastResult.status,
          pageDetected: lastResult.pageDetected,
          documentReady: lastResult.documentReady,
          sessionReady: lastResult.sessionReady,
          mainInterfaceReady: lastResult.mainInterfaceReady,
          qrDetected: lastResult.qrDetected,
          overallStatus: lastResult.overallStatus
        } : { lastStatus: "no_response" })
      }
    });
  }

  async waitForContentHandshake(
    tabId: number,
    timeoutMs: number,
    signal?: AbortSignal,
    options: ContentReadinessOptions = {}
  ): Promise<WhatsAppPreflightResult> {
    const key = `${tabId}:${options.navigationRequestId ?? options.previousContentInstanceId ?? "unscoped"}`;
    const existing = this.inFlightHandshakes.get(key);
    if (existing) return existing;
    const pending = this.waitForReadiness(tabId, timeoutMs, signal, options, "handshake")
      .finally(() => {
        if (this.inFlightHandshakes.get(key) === pending) this.inFlightHandshakes.delete(key);
      });
    this.inFlightHandshakes.set(key, pending);
    return pending;
  }

  async waitForSemanticReady(
    tabId: number,
    timeoutMs: number,
    signal?: AbortSignal,
    options: ContentReadinessOptions = {}
  ): Promise<WhatsAppPreflightResult> {
    return this.waitForReadiness(tabId, timeoutMs, signal, options, "semantic");
  }

  async waitForContent(
    tabId: number,
    timeoutMs: number,
    signal?: AbortSignal,
    options: ContentReadinessOptions = {}
  ): Promise<WhatsAppPreflightResult> {
    return this.waitForReadiness(tabId, timeoutMs, signal, options, "legacy");
  }
}
