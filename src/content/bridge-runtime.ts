export interface BridgeRuntimeMetadata {
  extensionVersion: string;
  manifestVersion: number;
}

export interface BridgeInstanceGuard {
  instanceId: string;
  isCurrent(): boolean;
  release(): void;
}

type BridgeMarkerRoot = Pick<Element, "getAttribute" | "setAttribute" | "removeAttribute">;

const BRIDGE_INSTANCE_ATTRIBUTE = "data-flormia-whatsapp-bridge-instance";

export function captureBridgeRuntimeMetadata(
  runtime: Pick<typeof chrome.runtime, "getManifest"> = chrome.runtime
): BridgeRuntimeMetadata {
  try {
    const manifest = runtime.getManifest();
    return {
      extensionVersion: typeof manifest.version === "string" && manifest.version ? manifest.version : "unknown",
      manifestVersion: Number(manifest.manifest_version) || 3
    };
  } catch {
    return { extensionVersion: "unknown", manifestVersion: 3 };
  }
}

export function installBridgeInstanceGuard(
  root: BridgeMarkerRoot = document.documentElement
): BridgeInstanceGuard {
  const instanceId = globalThis.crypto?.randomUUID?.() ?? `bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  root.setAttribute(BRIDGE_INSTANCE_ATTRIBUTE, instanceId);
  const isCurrent = (): boolean => root.getAttribute(BRIDGE_INSTANCE_ATTRIBUTE) === instanceId;
  return {
    instanceId,
    isCurrent,
    release: () => {
      if (isCurrent()) root.removeAttribute(BRIDGE_INSTANCE_ATTRIBUTE);
    }
  };
}

export function isExtensionContextInvalidated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /extension context invalidated/i.test(message);
}

export function invalidatedContextMessage(): string {
  return "La extensión fue recargada o actualizada y esta pestaña conserva un bridge anterior. Recargá esta pestaña para reconectar la extensión.";
}
