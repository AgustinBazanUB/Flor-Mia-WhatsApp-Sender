import { describe, expect, it, vi } from "vitest";
import { WhatsAppTransport } from "../src/background/whatsapp-transport";
import { createUnavailablePreflight } from "../src/compatibility/preflight-result";
import type { WhatsAppPreflightRequest } from "../src/compatibility/types";

function green(request: WhatsAppPreflightRequest) {
  return {
    ...createUnavailablePreflight("fixture", request, { pageDetected: true, contentScriptConnected: true }),
    documentReady: true,
    sessionReady: true,
    mainInterfaceReady: true,
    operational: true,
    overallStatus: "GREEN" as const,
    status: "ready" as const,
    message: "GREEN"
  };
}

describe("WhatsAppTransport readiness performance", () => {
  it("uses only lightweight session/surface checks while waiting for content", async () => {
    const transport = new WhatsAppTransport();
    const send = vi.spyOn(transport, "send").mockImplementation(async (_type, payload) => {
      const request = payload as WhatsAppPreflightRequest;
      return green(request) as never;
    });

    const result = await transport.waitForContent(7, 2_000);

    expect(result.operational).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const request = send.mock.calls[0]?.[1] as WhatsAppPreflightRequest;
    expect(request.level).toBe("lightweight");
    expect(request.requirements).toEqual({ needsText: false, needsImages: false });
    expect(request.timeoutMs).toBeLessThanOrEqual(1_000);
  });

  it("honors cancellation before starting another readiness probe", async () => {
    const transport = new WhatsAppTransport();
    const send = vi.spyOn(transport, "send");
    const controller = new AbortController();
    controller.abort();

    await expect(transport.waitForContent(7, 2_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(send).not.toHaveBeenCalled();
  });
});
