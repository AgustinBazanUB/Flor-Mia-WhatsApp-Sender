import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { recordObserverCreated, recordObserverDisconnected, recordTimerCleared, recordTimerCreated } from "../performance/runtime-metrics";

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  root?: Node;
  description?: string;
  observe?: MutationObserverInit;
}

export async function waitForCondition<T>(
  predicate: () => T | null | undefined | false,
  options: WaitOptions = {}
): Promise<T> {
  const {
    timeoutMs = 10_000,
    signal,
    root = document.documentElement,
    description = "la condición esperada",
    observe = { childList: true, subtree: true, attributes: true, characterData: true }
  } = options;

  const initial = predicate();
  if (initial) return initial;
  if (signal?.aborted) throw new DOMException("Operación cancelada", "AbortError");

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      recordObserverDisconnected();
      clearTimeout(timer);
      recordTimerCleared();
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const check = (): void => {
      try {
        const value = predicate();
        if (value) finish(() => resolve(value));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const observer = new MutationObserver(check);
    recordObserverCreated();
    recordTimerCreated();
    const timer = globalThis.setTimeout(() => {
      finish(() => reject(new ExtensionError(ERROR_CODES.timeout, `Tiempo agotado esperando ${description}.`, {
        details: { timeoutMs, description }
      })));
    }, timeoutMs);
    const onAbort = (): void => finish(() => reject(new DOMException("Operación cancelada", "AbortError")));
    signal?.addEventListener("abort", onAbort, { once: true });
    observer.observe(root, observe);
  });
}

export type DocumentReadySignal = "ready-state" | "semantic-surface";

export async function waitForDocumentReady(
  timeoutMs = 10_000,
  semanticReady?: () => boolean
): Promise<DocumentReadySignal> {
  const currentSignal = (): DocumentReadySignal | null => {
    if (document.readyState === "interactive" || document.readyState === "complete") return "ready-state";
    if (semanticReady?.()) return "semantic-surface";
    return null;
  };

  const initial = currentSignal();
  if (initial) return initial;

  return new Promise<DocumentReadySignal>((resolve, reject) => {
    let settled = false;
    let observer: MutationObserver | null = null;

    const cleanup = (): void => {
      document.removeEventListener("readystatechange", check);
      document.removeEventListener("DOMContentLoaded", check);
      globalThis.removeEventListener?.("load", check as EventListener);
      if (observer) {
        observer.disconnect();
        recordObserverDisconnected();
      }
      globalThis.clearTimeout(timer);
      recordTimerCleared();
    };

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const check = (): void => {
      try {
        const signal = currentSignal();
        if (signal) finish(() => resolve(signal));
      } catch (error) {
        finish(() => reject(error));
      }
    };

    recordTimerCreated();
    const timer = globalThis.setTimeout(() => {
      finish(() => reject(new ExtensionError(ERROR_CODES.timeout, "Tiempo agotado esperando que WhatsApp Web quede utilizable.", {
        details: { timeoutMs, readyState: document.readyState }
      })));
    }, timeoutMs);

    document.addEventListener("readystatechange", check);
    document.addEventListener("DOMContentLoaded", check);
    globalThis.addEventListener?.("load", check as EventListener);

    const root = document.documentElement ?? document;
    observer = new MutationObserver(check);
    recordObserverCreated();
    // Sólo cambios estructurales durante esta espera acotada. No observamos atributos
    // globales ni mantenemos un interval de 100 ms sobre toda la sesión.
    observer.observe(root, { childList: true, subtree: true });
  });
}
