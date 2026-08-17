export interface BridgeRuntimeMetadata {
  extensionVersion: string;
  manifestVersion: number;
}

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

export function isExtensionContextInvalidated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /extension context invalidated/i.test(message);
}

export function invalidatedContextMessage(): string {
  return "La extensión fue recargada o actualizada y esta pestaña conserva un bridge anterior. Recargá esta pestaña para reconectar la extensión.";
}
