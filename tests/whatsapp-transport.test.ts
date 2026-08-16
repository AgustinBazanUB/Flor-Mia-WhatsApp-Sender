import { describe, expect, it, vi } from "vitest";
import { WhatsAppTransport } from "../src/background/whatsapp-transport";
import { ERROR_CODES, ExtensionError } from "../src/shared/errors";
import { INTERNAL_MESSAGE_TYPES } from "../src/shared/protocol";

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
});
