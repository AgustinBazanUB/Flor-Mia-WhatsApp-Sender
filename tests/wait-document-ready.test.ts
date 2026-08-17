// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { waitForDocumentReady } from "../src/whatsapp/wait";

describe("WhatsApp document readiness", () => {
  it("reacts to readystatechange even when no DOM mutation occurs", async () => {
    let readyState = "loading";
    const originalDescriptor = Object.getOwnPropertyDescriptor(document, "readyState");
    Object.defineProperty(document, "readyState", { configurable: true, get: () => readyState });
    try {
      const pending = waitForDocumentReady(200);
      globalThis.setTimeout(() => {
        readyState = "interactive";
        document.dispatchEvent(new Event("readystatechange"));
      }, 5);
      await expect(pending).resolves.toBe("ready-state");
    } finally {
      if (originalDescriptor) Object.defineProperty(document, "readyState", originalDescriptor);
      else delete (document as unknown as { readyState?: string }).readyState;
    }
  });

  it("accepts an explicitly verified semantic surface while readyState stays loading", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(document, "readyState");
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
    let semanticReady = false;
    try {
      const pending = waitForDocumentReady(300, () => semanticReady);
      globalThis.setTimeout(() => { semanticReady = true; }, 10);
      await expect(pending).resolves.toBe("semantic-surface");
    } finally {
      if (originalDescriptor) Object.defineProperty(document, "readyState", originalDescriptor);
      else delete (document as unknown as { readyState?: string }).readyState;
    }
  });
});
