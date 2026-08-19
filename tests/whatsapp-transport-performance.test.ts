import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppTransport } from "../src/background/whatsapp-transport";
import { createUnavailablePreflight } from "../src/compatibility/preflight-result";
import { INTERNAL_MESSAGE_TYPES } from "../src/shared/protocol";
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

afterEach(() => vi.unstubAllGlobals());

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

  it("deduplicates two identical concurrent preflights on the same WhatsApp tab", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sendMessage = vi.fn(async (_tabId: number, envelope: { requestId: string; payload: WhatsAppPreflightRequest }) => {
      await gate;
      return { ok: true, requestId: envelope.requestId, data: green(envelope.payload) };
    });
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://web.whatsapp.com/" })),
        query: vi.fn(async () => [{ id: 7, url: "https://web.whatsapp.com/" }]),
        sendMessage
      }
    });
    const transport = new WhatsAppTransport();
    const request: WhatsAppPreflightRequest = {
      timeoutMs: 1_000,
      level: "lightweight",
      requirements: { needsText: false, needsImages: false }
    };

    const first = transport.send(INTERNAL_MESSAGE_TYPES.whatsappPreflight, request, 7);
    const second = transport.send(INTERNAL_MESSAGE_TYPES.whatsappPreflight, request, 7);
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a.operational).toBe(true);
    expect(b.operational).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
