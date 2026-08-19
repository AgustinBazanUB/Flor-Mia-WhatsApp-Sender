import fs from "node:fs";
import { execFileSync } from "node:child_process";

const mode = process.argv[2];
if (!new Set(["core", "tests", "version"]).has(mode)) {
  throw new Error("Uso: node scripts/apply-p0-handshake-fix.mjs <core|tests|version>");
}

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function write(path, content) {
  fs.writeFileSync(path, content, "utf8");
}

function replaceRequired(path, from, to) {
  const source = read(path);
  if (!source.includes(from)) throw new Error(`No se encontró el bloque esperado en ${path}`);
  write(path, source.replace(from, to));
}

function replaceSection(path, startMarker, endMarker, replacement) {
  const source = read(path);
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`No se encontró el inicio esperado en ${path}: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`No se encontró el final esperado en ${path}: ${endMarker}`);
  write(path, `${source.slice(0, start)}${replacement}${source.slice(end)}`);
}

const transportSource = String.raw`import { ERROR_CODES, ExtensionError, isExtensionErrorCode } from "../shared/errors";
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
  finalStatus: chrome.tabs.TabStatus | null;
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
      let lastStatus: chrome.tabs.TabStatus | null = null;
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
      const inspect = (changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void => {
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
      const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void => {
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
    if (!chrome.tabs.onUpdated?.addListener) {
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
      const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
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

  private async finalTabDiagnostics(tabId: number, expectedPhoneDigits?: string): Promise<{ tabStatus: chrome.tabs.TabStatus | null; urlMatched: boolean }> {
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
`;

const openConversationSource = String.raw`  async openConversation(
    contact: Parameters<ContactAdapter["openConversation"]>[0],
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new DOMException("Operación cancelada", "AbortError");
    const operationStartedMs = Date.now();
    const deadlineMs = operationStartedMs + timeoutMs;
    const remainingBudget = (stage: "navigation" | "content_handshake" | "semantic_ready" | "conversation_proof"): number => {
      const remaining = deadlineMs - Date.now();
      if (remaining > 0) return remaining;
      throw new ExtensionError(ERROR_CODES.timeout, "WhatsApp agotó el tiempo disponible para abrir la conversación.", {
        details: { stage, deadlineRemainingMs: 0 }
      });
    };
    const persistedTabId = Number.isInteger(contact.whatsappTabId) ? contact.whatsappTabId! : null;
    const boundTabId = this.whatsappTabId ?? persistedTabId;
    const tab = boundTabId === null
      ? await this.transport.requireTab()
      : await this.transport.requireTabId(boundTabId);
    this.whatsappTabId = tab.id;
    await this.persistTabBinding(contact, tab.id);

    let pending = this.pendingConversationOpen;
    if (!pending
      || pending.contactId !== contact.contactId
      || pending.phoneDigits !== contact.phoneDigits
      || pending.tabId !== tab.id) {
      const navigationStartedMs = Date.now();
      const navigationRequestId = createNavigationRequestId(contact.contactId);
      try {
        const navigation = await this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, {
          operationId: `open:${contact.contactId}`,
          phoneDigits: contact.phoneDigits,
          navigationRequestId
        }, tab.id);
        if (navigation.navigationRequestId !== navigationRequestId) {
          throw new ExtensionError(ERROR_CODES.protocolError, "La navegación de WhatsApp respondió con una correlación distinta.", { recoverable: false });
        }
        pending = {
          contactId: contact.contactId,
          phoneDigits: contact.phoneDigits,
          tabId: tab.id,
          navigationRequestId,
          previousContentInstanceId: navigation.contentInstanceId,
          requestedNavigationAt: navigation.requestedNavigationAt,
          navigationRequestedMs: Date.now()
        };
        this.pendingConversationOpen = pending;
        const lifecycle = await this.transport.waitForNavigationLifecycle(
          tab.id,
          Math.min(10_000, remainingBudget("navigation")),
          signal,
          { expectedPhoneDigits: contact.phoneDigits, navigationRequestId }
        );
        pending.navigationObservedAt = lifecycle.observedAt;
        pending.tabLoadingAt = lifecycle.loadingAt;
        pending.tabCompleteAt = lifecycle.completeAt;
        await this.recordOpenStage(contact, "navigation", "confirmed", navigationStartedMs);
        logger.info("whatsapp.open_conversation_stage", {
          operationId: `open:${contact.contactId}`,
          navigationRequestId,
          stage: "navigation_observed",
          tabLoadingAt: lifecycle.loadingAt,
          tabCompleteAt: lifecycle.completeAt,
          tabStatus: lifecycle.finalStatus,
          elapsedMs: Date.now() - operationStartedMs,
          deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
        });
      } catch (error) {
        this.pendingConversationOpen = null;
        const normalized = stageError(error, "navigation", Date.now() - navigationStartedMs);
        await this.recordOpenStage(contact, "navigation", "failed", navigationStartedMs, normalized.code);
        throw normalized;
      }
    } else {
      await this.recordOpenStage(contact, "navigation", "reused", Date.now());
      logger.debug("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        navigationRequestId: pending.navigationRequestId,
        stage: "reuse_pending_navigation",
        elapsedMs: Date.now() - operationStartedMs,
        deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
      });
    }

    const handshakeStartedMs = Date.now();
    let handshake;
    try {
      handshake = await this.transport.waitForContentHandshake(tab.id, remainingBudget("content_handshake"), signal, {
        previousContentInstanceId: pending.previousContentInstanceId,
        purpose: "content_handshake",
        navigationRequestId: pending.navigationRequestId
      });
      await this.recordOpenStage(contact, "content_handshake", "confirmed", handshakeStartedMs);
    } catch (error) {
      const normalized = stageError(error, "content_handshake", Date.now() - handshakeStartedMs);
      if (normalized.code === ERROR_CODES.whatsappNotOpen) this.pendingConversationOpen = null;
      await this.recordOpenStage(contact, "content_handshake", "failed", handshakeStartedMs, normalized.code);
      logger.warn("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        navigationRequestId: pending.navigationRequestId,
        stage: "content_handshake_failed",
        errorCode: normalized.code,
        elapsedMs: Date.now() - handshakeStartedMs,
        deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
      });
      throw normalized;
    }
    const handshakeAt = new Date().toISOString();
    logger.info("whatsapp.open_conversation_stage", {
      operationId: `open:${contact.contactId}`,
      navigationRequestId: pending.navigationRequestId,
      stage: "content_handshake_confirmed",
      oldContentGeneration: pending.previousContentInstanceId,
      newContentGeneration: handshake.contentInstanceId ?? null,
      handshakeStartedAt: new Date(handshakeStartedMs).toISOString(),
      handshakeConfirmedAt: handshakeAt,
      elapsedMs: Date.now() - handshakeStartedMs,
      navigationToHandshakeMs: Date.now() - pending.navigationRequestedMs,
      deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
    });

    if (signal?.aborted) throw new DOMException("Operación cancelada", "AbortError");

    const semanticStartedMs = Date.now();
    let result;
    try {
      result = await this.transport.waitForSemanticReady(tab.id, remainingBudget("semantic_ready"), signal, {
        expectedContentInstanceId: handshake.contentInstanceId,
        navigationRequestId: pending.navigationRequestId
      });
      if (!result.operational) {
        if (result.qrDetected) throw new ExtensionError(ERROR_CODES.sessionNotReady, result.message);
        if (result.status === "incompatible") {
          const failed = Object.values(result.capabilities).find((capability) => capability.required && capability.state !== "available");
          throw new ExtensionError(ERROR_CODES.preflightFailed, result.message, {
            recoverable: false,
            ...(failed ? {
              details: {
                compatibilityDiagnostic: {
                  capability: failed.capability,
                  logicalStep: failed.logicalStep,
                  expectedStrategies: failed.attempts.map((attempt) => attempt.strategyId),
                  currentStrategiesAttempted: failed.attempts,
                  expectedSemanticElement: failed.expectedSemanticElement,
                  candidateCount: failed.candidateCount,
                  candidateSummaries: failed.candidateSummaries,
                  timestamp: result.checkedAt
                }
              }
            } : {})
          });
        }
        throw new ExtensionError(ERROR_CODES.interfaceLoading, result.message);
      }
      await this.recordOpenStage(contact, "semantic_ready", "confirmed", semanticStartedMs);
      logger.info("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        navigationRequestId: pending.navigationRequestId,
        stage: "semantic_ready_confirmed",
        semanticReadyAt: new Date().toISOString(),
        elapsedMs: Date.now() - semanticStartedMs,
        deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
      });
    } catch (error) {
      const normalized = stageError(error, "semantic_ready", Date.now() - semanticStartedMs);
      await this.recordOpenStage(contact, "semantic_ready", "failed", semanticStartedMs, normalized.code);
      throw normalized;
    }

    if (signal?.aborted) throw new DOMException("Operación cancelada", "AbortError");

    const proofOperationId = `prove:${contact.contactId}:${pending.navigationRequestId}`;
    const proofStartedMs = Date.now();
    const onAbort = (): void => {
      void this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappCancelOperation, { operationId: proofOperationId }, tab.id).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const proof = await this.transport.send(INTERNAL_MESSAGE_TYPES.whatsappProveConversation, {
        operationId: proofOperationId,
        phoneDigits: contact.phoneDigits,
        navigationRequestId: pending.navigationRequestId,
        timeoutMs: Math.min(remainingBudget("conversation_proof"), CONVERSATION_PROOF_BUDGET_MS),
        requestedNavigationAt: pending.requestedNavigationAt,
        navigationObservedAt: pending.navigationObservedAt ?? handshakeAt,
        ...(result.contentInstanceId ? { expectedContentInstanceId: result.contentInstanceId } : {})
      }, this.requireBoundTabId());
      await this.recordOpenStage(contact, "conversation_proof", "confirmed", proofStartedMs);
      logger.info("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        navigationRequestId: pending.navigationRequestId,
        stage: "conversation_proof_confirmed",
        conversationProofAt: new Date().toISOString(),
        proofLevel: proof.proofLevel,
        proofStrategy: proof.evidence,
        elapsedMs: Date.now() - proofStartedMs,
        totalOpenConversationMs: Date.now() - operationStartedMs,
        deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
      });
      this.pendingConversationOpen = null;
    } catch (error) {
      const normalized = stageError(error, "conversation_proof", Date.now() - proofStartedMs);
      await this.recordOpenStage(contact, "conversation_proof", "failed", proofStartedMs, normalized.code);
      logger.warn("whatsapp.open_conversation_stage", {
        operationId: `open:${contact.contactId}`,
        navigationRequestId: pending.navigationRequestId,
        stage: "conversation_proof_failed",
        errorCode: normalized.code,
        proofFailureReason: normalized.details?.proofFailureReason ?? null,
        elapsedMs: Date.now() - proofStartedMs,
        deadlineRemainingMs: Math.max(0, deadlineMs - Date.now())
      });
      throw normalized;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
`;

function patchCore() {
  write("src/background/whatsapp-transport.ts", transportSource);

  replaceRequired(
    "src/compatibility/types.ts",
    'export type PreflightPurpose = "campaign_start" | "health_check" | "content_handshake" | "manual_diagnostic" | "unspecified";',
    'export type PreflightPurpose = "campaign_start" | "health_check" | "content_handshake" | "semantic_ready" | "manual_diagnostic" | "unspecified";'
  );

  replaceRequired(
    "src/whatsapp/preflight.ts",
    '  const pageDetected = window.location.origin === "https://web.whatsapp.com";\n\n  let readinessSignal:',
    '  const pageDetected = window.location.origin === "https://web.whatsapp.com";\n  const handshakeOnly = request.purpose === "content_handshake" && level === "lightweight";\n\n  let readinessSignal:'
  );
  replaceRequired(
    "src/whatsapp/preflight.ts",
    "  if (pageDetected && !documentReady) {",
    "  if (pageDetected && !documentReady && !handshakeOnly) {"
  );
  replaceRequired(
    "src/whatsapp/preflight.ts",
    "  if (pageDetected && documentReady && !findQrCode() && !resolveCapability(\"main_interface\").match && !findComposer()) {",
    "  if (!handshakeOnly && pageDetected && documentReady && !findQrCode() && !resolveCapability(\"main_interface\").match && !findComposer()) {"
  );
  replaceRequired(
    "src/whatsapp/preflight.ts",
    "  if (pageDetected && documentReady && inspectConversation && request.targetedCapability && !findQrCode() && !findComposer()) {",
    "  if (!handshakeOnly && pageDetected && documentReady && inspectConversation && request.targetedCapability && !findQrCode() && !findComposer()) {"
  );

  replaceRequired(
    "src/engine/retry-policy.ts",
    "    openConversationMs: 30_000,",
    "    openConversationMs: 40_000,"
  );

  replaceRequired(
    "src/background/contact-adapter.ts",
    '    stage: "navigation" | "content_handshake" | "conversation_proof",',
    '    stage: "navigation" | "content_handshake" | "semantic_ready" | "conversation_proof",'
  );
  replaceRequired(
    "src/background/contact-adapter.ts",
    "  navigationRequestedMs: number;\n}",
    "  navigationRequestedMs: number;\n  navigationObservedAt?: string;\n  tabLoadingAt?: string | null;\n  tabCompleteAt?: string | null;\n}"
  );
  replaceSection(
    "src/background/contact-adapter.ts",
    "  async openConversation(\n",
    "\n  private requireBoundTabId(): number {",
    openConversationSource
  );

  const oldTestFlow = `    const navigation = await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, {\n      operationId,\n      phoneDigits: phone.digits,\n      navigationRequestId\n    }, tab.id);\n    await stateStore.patch({\n      currentStep: "wait-conversation",\n      lastCheckpoint: { operationId, recipientId: operationId, step: "navigation-requested", createdAt: new Date().toISOString() }\n    });\n    const readiness = await whatsappTransport.waitForContent(tab.id, 30_000, undefined, {\n      previousContentInstanceId: navigation.contentInstanceId,\n      purpose: "content_handshake"\n    });\n    const navigationObservedAt = new Date().toISOString();`;
  const newTestFlow = `    const openDeadlineMs = Date.now() + 40_000;\n    const remainingOpenBudget = () => Math.max(1, openDeadlineMs - Date.now());\n    const navigation = await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, {\n      operationId,\n      phoneDigits: phone.digits,\n      navigationRequestId\n    }, tab.id);\n    await stateStore.patch({\n      currentStep: "wait-conversation",\n      lastCheckpoint: { operationId, recipientId: operationId, step: "navigation-requested", createdAt: new Date().toISOString() }\n    });\n    const lifecycle = await whatsappTransport.waitForNavigationLifecycle(\n      tab.id,\n      Math.min(10_000, remainingOpenBudget()),\n      undefined,\n      { expectedPhoneDigits: phone.digits, navigationRequestId }\n    );\n    const handshake = await whatsappTransport.waitForContentHandshake(tab.id, remainingOpenBudget(), undefined, {\n      previousContentInstanceId: navigation.contentInstanceId,\n      purpose: "content_handshake",\n      navigationRequestId\n    });\n    const readiness = await whatsappTransport.waitForSemanticReady(tab.id, remainingOpenBudget(), undefined, {\n      expectedContentInstanceId: handshake.contentInstanceId,\n      navigationRequestId\n    });\n    const navigationObservedAt = lifecycle.observedAt;`;
  replaceRequired("src/background/service-worker.ts", oldTestFlow, newTestFlow);
}

const lifecycleTestSource = String.raw`import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppTransport, classifyContentTransportFailure } from "../src/background/whatsapp-transport";
import { ERROR_CODES } from "../src/shared/errors";
import { createUnavailablePreflight } from "../src/compatibility/preflight-result";
import type { WhatsAppPreflightRequest } from "../src/compatibility/types";

function event<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: vi.fn((listener: T) => listeners.add(listener)),
    removeListener: vi.fn((listener: T) => listeners.delete(listener)),
    emit: (...args: Parameters<T>) => [...listeners].forEach((listener) => listener(...args)),
    size: () => listeners.size
  };
}

function handshakeFixture(request: WhatsAppPreflightRequest, contentInstanceId = "content-new", operational = false) {
  return {
    ...createUnavailablePreflight("fixture", request, { pageDetected: true, contentScriptConnected: true }),
    contentInstanceId,
    documentReady: operational,
    sessionReady: operational,
    mainInterfaceReady: operational,
    operational,
    overallStatus: operational ? "GREEN" as const : "RED" as const,
    status: operational ? "ready" as const : "loading" as const,
    message: operational ? "GREEN" : "loading"
  };
}

function chromeFor(sendMessage = vi.fn()) {
  const onUpdated = event<(tabId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void>();
  const onRemoved = event<(tabId: number) => void>();
  let current = { id: 7, url: "https://web.whatsapp.com/", status: "complete" as const };
  const get = vi.fn(async () => current);
  return {
    onUpdated,
    onRemoved,
    setTab(tab: typeof current) { current = tab; },
    chrome: {
      tabs: {
        get,
        query: vi.fn(async () => [current]),
        sendMessage,
        onUpdated,
        onRemoved
      }
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("post-navigation lifecycle", () => {
  it("resolves immediately when the requested /send document is already complete", async () => {
    const mock = chromeFor();
    mock.setTab({ id: 7, url: "https://web.whatsapp.com/send?phone=5491112345678&type=phone_number", status: "complete" });
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();

    await expect(transport.waitForNavigationLifecycle(7, 1_000, undefined, {
      expectedPhoneDigits: "5491112345678",
      navigationRequestId: "nav-1",
      waitForComplete: true
    })).resolves.toMatchObject({ finalStatus: "complete", urlMatched: true });
    expect(mock.onUpdated.size()).toBe(0);
    expect(mock.onRemoved.size()).toBe(0);
  });

  it("waits through loading until complete when complete is explicitly required", async () => {
    const mock = chromeFor();
    mock.setTab({ id: 7, url: "https://web.whatsapp.com/send?phone=5491112345678", status: "loading" });
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForNavigationLifecycle(7, 2_000, undefined, {
      expectedPhoneDigits: "5491112345678",
      waitForComplete: true
    });
    await Promise.resolve();
    mock.onUpdated.emit(7, { status: "complete" }, {
      id: 7,
      url: "https://web.whatsapp.com/send?phone=5491112345678",
      status: "complete"
    });
    await expect(waiting).resolves.toMatchObject({ finalStatus: "complete" });
  });

  it("ignores lifecycle events from another tab", async () => {
    const mock = chromeFor();
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForNavigationLifecycle(7, 2_000, undefined, {
      expectedPhoneDigits: "5491112345678"
    });
    await Promise.resolve();
    mock.onUpdated.emit(8, { url: "https://web.whatsapp.com/send?phone=5491112345678" }, {
      id: 8,
      url: "https://web.whatsapp.com/send?phone=5491112345678",
      status: "loading"
    });
    expect(mock.onUpdated.size()).toBe(1);
    mock.onUpdated.emit(7, { url: "https://web.whatsapp.com/send?phone=5491112345678", status: "loading" }, {
      id: 7,
      url: "https://web.whatsapp.com/send?phone=5491112345678",
      status: "loading"
    });
    await expect(waiting).resolves.toMatchObject({ urlMatched: true });
  });

  it("fails closed when the bound tab is closed", async () => {
    const mock = chromeFor();
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForNavigationLifecycle(7, 2_000, undefined, { expectedPhoneDigits: "5491112345678" });
    await Promise.resolve();
    mock.onRemoved.emit(7);
    await expect(waiting).rejects.toMatchObject({ code: ERROR_CODES.whatsappNotOpen });
    expect(mock.onUpdated.size()).toBe(0);
  });

  it("aborts and removes listeners immediately", async () => {
    const mock = chromeFor();
    vi.stubGlobal("chrome", mock.chrome);
    const controller = new AbortController();
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForNavigationLifecycle(7, 2_000, controller.signal, { expectedPhoneDigits: "5491112345678" });
    await Promise.resolve();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.onUpdated.size()).toBe(0);
    expect(mock.onRemoved.size()).toBe(0);
  });

  it("times out and removes listeners", async () => {
    vi.useFakeTimers();
    const mock = chromeFor();
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForNavigationLifecycle(7, 500, undefined, { expectedPhoneDigits: "5491112345678" });
    await vi.advanceTimersByTimeAsync(500);
    await expect(waiting).rejects.toMatchObject({ code: ERROR_CODES.timeout, details: { stage: "navigation" } });
    expect(mock.onUpdated.size()).toBe(0);
    expect(mock.onRemoved.size()).toBe(0);
  });
});

describe("content handshake recovery", () => {
  it("classifies the two expected navigation receiver gaps as transient", () => {
    expect(classifyContentTransportFailure(new Error("Could not establish connection. Receiving end does not exist."))).toBe("RECEIVING_END_NOT_READY");
    expect(classifyContentTransportFailure(new Error("The message port closed before a response was received."))).toBe("MESSAGE_PORT_CLOSED_DURING_NAVIGATION");
  });

  it("retries a missing receiver and resolves as soon as the fresh content generation answers", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const sendMessage = vi.fn(async (_tabId: number, envelope: { requestId: string; payload: WhatsAppPreflightRequest }) => {
      attempt += 1;
      if (attempt === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { ok: true, requestId: envelope.requestId, data: handshakeFixture(envelope.payload, "content-new", false) };
    });
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForContentHandshake(7, 3_000, undefined, {
      previousContentInstanceId: "content-old",
      navigationRequestId: "nav-1"
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(waiting).resolves.toMatchObject({ contentInstanceId: "content-new", documentReady: false });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("retries a message-port closure during navigation", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const sendMessage = vi.fn(async (_tabId: number, envelope: { requestId: string; payload: WhatsAppPreflightRequest }) => {
      attempt += 1;
      if (attempt === 1) throw new Error("The message port closed before a response was received.");
      return { ok: true, requestId: envelope.requestId, data: handshakeFixture(envelope.payload, "content-new", false) };
    });
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForContentHandshake(7, 3_000, undefined, {
      previousContentInstanceId: "content-old",
      navigationRequestId: "nav-2"
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(waiting).resolves.toMatchObject({ contentInstanceId: "content-new" });
  });

  it("fails immediately on permission errors", async () => {
    const sendMessage = vi.fn(async () => { throw new Error("Missing host permission for the tab"); });
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    await expect(transport.waitForContentHandshake(7, 3_000, undefined, { navigationRequestId: "nav-3" }))
      .rejects.toMatchObject({ code: ERROR_CODES.protocolError, recoverable: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("fails immediately when the bound tab changed origin", async () => {
    const mock = chromeFor();
    mock.setTab({ id: 7, url: "https://example.com/", status: "complete" });
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    await expect(transport.waitForContentHandshake(7, 3_000, undefined, { navigationRequestId: "nav-4" }))
      .rejects.toMatchObject({ code: ERROR_CODES.protocolError, recoverable: false, details: { probeErrorKind: "WRONG_ORIGIN" } });
  });

  it("ignores the old generation until the post-navigation content script replies", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const sendMessage = vi.fn(async (_tabId: number, envelope: { requestId: string; payload: WhatsAppPreflightRequest }) => {
      attempt += 1;
      const id = attempt === 1 ? "content-old" : "content-new";
      return { ok: true, requestId: envelope.requestId, data: handshakeFixture(envelope.payload, id, false) };
    });
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForContentHandshake(7, 3_000, undefined, {
      previousContentInstanceId: "content-old",
      navigationRequestId: "nav-5"
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(waiting).resolves.toMatchObject({ contentInstanceId: "content-new" });
  });

  it("uses single-flight for the same tab and navigation request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sendMessage = vi.fn(async (_tabId: number, envelope: { requestId: string; payload: WhatsAppPreflightRequest }) => {
      await gate;
      return { ok: true, requestId: envelope.requestId, data: handshakeFixture(envelope.payload, "content-new", false) };
    });
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const options = { previousContentInstanceId: "content-old", navigationRequestId: "nav-single" };
    const first = transport.waitForContentHandshake(7, 3_000, undefined, options);
    const second = transport.waitForContentHandshake(7, 3_000, undefined, options);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.contentInstanceId).toBe("content-new");
    expect(b.contentInstanceId).toBe("content-new");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending handshake without waiting for its maximum budget", async () => {
    const sendMessage = vi.fn(() => new Promise(() => undefined));
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const controller = new AbortController();
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForContentHandshake(7, 40_000, controller.signal, { navigationRequestId: "nav-cancel" });
    await Promise.resolve();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports a safe timeout when the global handshake budget is exhausted", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(async (_tabId: number, envelope: { requestId: string; payload: WhatsAppPreflightRequest }) => ({
      ok: true,
      requestId: envelope.requestId,
      data: handshakeFixture(envelope.payload, "content-old", false)
    }));
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForContentHandshake(7, 900, undefined, {
      previousContentInstanceId: "content-old",
      navigationRequestId: "nav-timeout"
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).rejects.toMatchObject({
      code: ERROR_CODES.timeout,
      details: { stage: "content_handshake", contentGenerationChanged: false }
    });
  });
});
`;

function patchTests() {
  const path = "tests/contact-adapter-binding.test.ts";
  const source = read(path);
  const marker = `function checkpoint() {`;
  if (!source.includes(marker)) throw new Error("No se encontró marker de contact-adapter-binding.test.ts");
  const helper = String.raw`function withLifecycle<T extends Record<string, unknown>>(transport: T) {
  const legacyWait = (transport as { waitForContent?: (...args: any[]) => Promise<unknown> }).waitForContent;
  return {
    waitForNavigationLifecycle: async () => ({
      observedAt: NOW,
      loadingAt: NOW,
      completeAt: NOW,
      finalStatus: "complete" as const,
      urlMatched: true
    }),
    waitForContentHandshake: async (tabId: number, timeoutMs: number, signal: AbortSignal | undefined, options: {
      previousContentInstanceId?: string;
      navigationRequestId?: string;
    }) => legacyWait
      ? legacyWait(tabId, timeoutMs, signal, {
          previousContentInstanceId: options.previousContentInstanceId,
          purpose: "content_handshake"
        })
      : green("content-new"),
    waitForSemanticReady: async (_tabId: number, _timeoutMs: number, _signal: AbortSignal | undefined, options: {
      expectedContentInstanceId?: string;
    }) => green(options.expectedContentInstanceId ?? "content-new"),
    ...transport
  };
}

`;
  let next = source.replace(marker, `${helper}${marker}`);
  next = next.replaceAll("fakeTransport as unknown as WhatsAppTransport", "withLifecycle(fakeTransport) as unknown as WhatsAppTransport");
  write(path, next);
  write("tests/post-navigation-handshake.test.ts", lifecycleTestSource);
}

function patchVersion() {
  const manifestPath = "manifest.json";
  const manifest = JSON.parse(read(manifestPath));
  if (manifest.version !== "0.9.4" && manifest.version !== "0.9.4.1") throw new Error(`Versión inesperada: ${manifest.version}`);
  manifest.version = "0.9.4.1";
  manifest.version_name = "0.9.4.1";
  write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const pkg = JSON.parse(read("package.json"));
  if (pkg.version !== "0.9.4" && pkg.version !== "0.9.4.1") throw new Error(`package.json inesperado: ${pkg.version}`);
  if (pkg.version !== "0.9.4.1") {
    execFileSync("npm", ["version", "0.9.4.1", "--no-git-tag-version"], { stdio: "inherit" });
  }
}

if (mode === "core") patchCore();
if (mode === "tests") patchTests();
if (mode === "version") patchVersion();
