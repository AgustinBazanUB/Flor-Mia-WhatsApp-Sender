import { describe, expect, it } from "vitest";
import {
  captureBridgeRuntimeMetadata,
  installBridgeInstanceGuard,
  invalidatedContextMessage,
  isExtensionContextInvalidated
} from "../src/content/bridge-runtime";

class MarkerRoot {
  private readonly values = new Map<string, string>();
  getAttribute(name: string): string | null { return this.values.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.values.set(name, value); }
  removeAttribute(name: string): void { this.values.delete(name); }
}

describe("web-app bridge runtime lifecycle", () => {
  it("caches manifest metadata while the extension context is valid", () => {
    const metadata = captureBridgeRuntimeMetadata({
      getManifest: () => ({ version: "0.9.1.3", manifest_version: 3 }) as chrome.runtime.Manifest
    });
    expect(metadata).toEqual({ extensionVersion: "0.9.1.3", manifestVersion: 3 });
  });

  it("falls back without throwing when runtime metadata is unavailable", () => {
    const metadata = captureBridgeRuntimeMetadata({
      getManifest: () => { throw new Error("Extension context invalidated."); }
    });
    expect(metadata).toEqual({ extensionVersion: "unknown", manifestVersion: 3 });
  });

  it("recognizes an invalidated content-script context and gives a reload instruction", () => {
    expect(isExtensionContextInvalidated(new Error("Extension context invalidated."))).toBe(true);
    expect(isExtensionContextInvalidated(new Error("otro error"))).toBe(false);
    expect(invalidatedContextMessage()).toContain("Recargá esta pestaña");
  });

  it("lets the newest bridge instance supersede an older instance", () => {
    const root = new MarkerRoot();
    const first = installBridgeInstanceGuard(root as unknown as Element);
    expect(first.isCurrent()).toBe(true);

    const second = installBridgeInstanceGuard(root as unknown as Element);
    expect(second.isCurrent()).toBe(true);
    expect(first.isCurrent()).toBe(false);

    first.release();
    expect(second.isCurrent()).toBe(true);
    second.release();
    expect(second.isCurrent()).toBe(false);
  });
});
