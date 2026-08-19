export interface BridgeRuntimeMetadata {
  extensionVersion: string;
  manifestVersion: number;
  createdAt: string;
  runtimeAvailable: boolean;
}

export interface BridgeInstanceGuard {
  instanceId: string;
  generation: number;
  createdAt: string;
  isCurrent(): boolean;
  onSuperseded(callback: () => void): () => void;
  release(): void;
}

type BridgeMarkerRoot = Pick<Element, "getAttribute" | "setAttribute" | "removeAttribute">;

const BRIDGE_INSTANCE_ATTRIBUTE = "data-flormia-whatsapp-bridge-instance";
const BRIDGE_GENERATION_ATTRIBUTE = "data-flormia-whatsapp-bridge-generation";

export function isRuntimeAvailable(
  runtime: Pick<typeof chrome.runtime, "getManifest"> = chrome.runtime
): boolean {
  try {
    const manifest = runtime.getManifest();
    return Boolean(manifest && typeof manifest.version === "string");
  } catch {
    return false;
  }
}

export function captureBridgeRuntimeMetadata(
  runtime: Pick<typeof chrome.runtime, "getManifest"> = chrome.runtime
): BridgeRuntimeMetadata {
  const createdAt = new Date().toISOString();
  try {
    const manifest = runtime.getManifest();
    return {
      extensionVersion: typeof manifest.version === "string" && manifest.version ? manifest.version : "unknown",
      manifestVersion: Number(manifest.manifest_version) || 3,
      createdAt,
      runtimeAvailable: true
    };
  } catch {
    return { extensionVersion: "unknown", manifestVersion: 3, createdAt, runtimeAvailable: false };
  }
}

export function installBridgeInstanceGuard(
  root: BridgeMarkerRoot = document.documentElement
): BridgeInstanceGuard {
  const instanceId = globalThis.crypto?.randomUUID?.() ?? `bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const previousGeneration = Number.parseInt(root.getAttribute(BRIDGE_GENERATION_ATTRIBUTE) ?? "0", 10);
  const generation = Number.isFinite(previousGeneration) ? previousGeneration + 1 : 1;
  const createdAt = new Date().toISOString();
  root.setAttribute(BRIDGE_GENERATION_ATTRIBUTE, String(generation));
  root.setAttribute(BRIDGE_INSTANCE_ATTRIBUTE, instanceId);
  const isCurrent = (): boolean => root.getAttribute(BRIDGE_INSTANCE_ATTRIBUTE) === instanceId
    && root.getAttribute(BRIDGE_GENERATION_ATTRIBUTE) === String(generation);

  let released = false;
  let notified = false;
  const callbacks = new Set<() => void>();
  const notifyIfSuperseded = (): void => {
    if (released || notified || isCurrent()) return;
    notified = true;
    for (const callback of [...callbacks]) callback();
  };
  const observer = typeof MutationObserver === "function" && root instanceof Node
    ? new MutationObserver(notifyIfSuperseded)
    : null;
  if (observer && root instanceof Node) {
    observer.observe(root, {
      attributes: true,
      attributeFilter: [BRIDGE_INSTANCE_ATTRIBUTE, BRIDGE_GENERATION_ATTRIBUTE]
    });
  }

  return {
    instanceId,
    generation,
    createdAt,
    isCurrent,
    onSuperseded: (callback) => {
      callbacks.add(callback);
      notifyIfSuperseded();
      return () => callbacks.delete(callback);
    },
    release: () => {
      if (released) return;
      released = true;
      observer?.disconnect();
      callbacks.clear();
      if (isCurrent()) {
        root.removeAttribute(BRIDGE_INSTANCE_ATTRIBUTE);
        root.removeAttribute(BRIDGE_GENERATION_ATTRIBUTE);
      }
    }
  };
}

export function isExtensionContextInvalidated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /extension context invalidated/i.test(message);
}

export function invalidatedContextMessage(): string {
  return "Necesitamos reconectar la extensión. Esta pestaña conserva una instancia anterior después de una recarga o actualización.";
}
