import { ERROR_CODES, ExtensionError } from "../shared/errors";

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
      clearTimeout(timer);
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

export async function waitForDocumentReady(timeoutMs = 10_000): Promise<void> {
  await waitForCondition(
    () => document.readyState === "interactive" || document.readyState === "complete",
    { timeoutMs, root: document, description: "que WhatsApp Web termine de cargar" }
  );
}
