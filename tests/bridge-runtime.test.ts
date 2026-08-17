import { describe, expect, it } from "vitest";
import {
  captureBridgeRuntimeMetadata,
  invalidatedContextMessage,
  isExtensionContextInvalidated
} from "../src/content/bridge-runtime";

describe("web-app bridge runtime lifecycle", () => {
  it("caches manifest metadata while the extension context is valid", () => {
    const metadata = captureBridgeRuntimeMetadata({
      getManifest: () => ({ version: "0.9.1.2", manifest_version: 3 }) as chrome.runtime.Manifest
    });
    expect(metadata).toEqual({ extensionVersion: "0.9.1.2", manifestVersion: 3 });
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
});
