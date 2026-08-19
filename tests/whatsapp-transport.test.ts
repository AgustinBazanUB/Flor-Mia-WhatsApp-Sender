import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppTransport } from "../src/background/whatsapp-transport";
import { ERROR_CODES, ExtensionError } from "../src/shared/errors";
import { INTERNAL_MESSAGE_TYPES } from "../src/shared/protocol";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WhatsAppTransport.sendWhenContentReady", () => {
  it("waits for the reloaded content script and retries preflight once", async () => {
    const transport = new WhatsAppTransport();
    const result = { operational: true };
    const send = vi.spyOn(transport, "send")
      .mockRejectedValueOnce(new ExtensionError(ERROR_CODES.interfaceLoading, "reloading"))
      .mockResolvedValueOnce(result as never);
    const waitForContent = vi.spyOn(transport, "waitForContent").mockResolvedValue(result as never);

    await expect(transport.sendWhenContentReady(
      INTERNAL_MESSAGE_TYPES.whatsappPreflight,
      { timeoutMs: 4_000 },
      7,
      4_000
    )).resolves.toBe(result);

    expect(waitForContent).toHaveBeenCalledWith(7, 4_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not retry failures unrelated to a temporary content reload", async () => {
    const transport = new WhatsAppTransport();
    vi.spyOn(transport, "send").mockRejectedValue(
      new ExtensionError(ERROR_CODES.preflightFailed, "incompatible")
    );
    const waitForContent = vi.spyOn(transport, "waitForContent");

    await expect(transport.sendWhenContentReady(
      INTERNAL_MESSAGE_TYPES.whatsappPreflight,
      { timeoutMs: 4_000 },
      7,
      4_000
    )).rejects.toMatchObject({ code: ERROR_CODES.preflightFailed });

    expect(waitForContent).not.toHaveBeenCalled();
  });

  it("does not treat an early incompatible DOM as content-ready while WhatsApp is mounting", async () => {
    vi.useFakeTimers();
    try {
      const transport = new WhatsAppTransport();
      const mounting = { documentReady: true, operational: false, qrDetected: false, status: "incompatible" };
      const ready = { documentReady: true, operational: true, qrDetected: false, status: "ready" };
      const send = vi.spyOn(transport, "send")
        .mockResolvedValueOnce(mounting as never)
        .mockResolvedValueOnce(ready as never);

      const waiting = transport.waitForContent(7, 1_000);
      await vi.advanceTimersByTimeAsync(300);

      await expect(waiting).resolves.toBe(ready);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the bound WhatsApp tab valid when Chrome reports it as inactive", async () => {
    const get = vi.fn().mockResolvedValue({
      id: 7,
      url: "https://web.whatsapp.com/",
      active: false,
      windowId: 1
    });
    vi.stubGlobal("chrome", { tabs: { get } });

    const transport = new WhatsAppTransport();
    await expect(transport.requireTabId(7)).resolves.toMatchObject({ id: 7, active: false });
    expect(get).toHaveBeenCalledWith(7);
  });
});
