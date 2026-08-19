import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppTransport, classifyContentTransportFailure } from "../src/background/whatsapp-transport";
import { ERROR_CODES } from "../src/shared/errors";
import { createUnavailablePreflight } from "../src/compatibility/preflight-result";
import type { WhatsAppPreflightRequest } from "../src/compatibility/types";

type TestTabChangeInfo = {
  status?: chrome.tabs.Tab["status"];
  url?: string;
};

function event<TArgs extends unknown[]>() {
  type Listener = (...args: TArgs) => void;
  const listeners = new Set<Listener>();
  return {
    addListener: vi.fn((listener: Listener) => listeners.add(listener)),
    removeListener: vi.fn((listener: Listener) => listeners.delete(listener)),
    emit: (...args: TArgs) => [...listeners].forEach((listener) => listener(...args)),
    size: () => listeners.size
  };
}

function handshakeFixture(request: WhatsAppPreflightRequest, contentInstanceId = "content-new", operational = false) {
  return {
    ...createUnavailablePreflight("fixture", request, { pageDetected: true, contentScriptConnected: true }),
    contentInstanceId,
    documentReady: operational,
    sessionReady: operational,
    mainInterfaceReady: operational,
    operational,
    overallStatus: operational ? "GREEN" as const : "RED" as const,
    status: operational ? "ready" as const : "loading" as const,
    message: operational ? "GREEN" : "loading"
  };
}

type TestTab = {
  id: number;
  url: string;
  status: chrome.tabs.Tab["status"];
};

function chromeFor(sendMessage = vi.fn()) {
  const onUpdated = event<[number, TestTabChangeInfo, TestTab]>();
  const onRemoved = event<[number]>();
  let current: TestTab = { id: 7, url: "https://web.whatsapp.com/", status: "complete" };
  const get = vi.fn(async () => current);
  return {
    onUpdated,
    onRemoved,
    setTab(tab: TestTab) { current = tab; },
    chrome: {
      tabs: {
        get,
        query: vi.fn(async () => [current]),
        sendMessage,
        onUpdated,
        onRemoved
      }
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("post-navigation lifecycle", () => {
  it("resolves immediately when the requested /send document is already complete", async () => {
    const mock = chromeFor();
    mock.setTab({ id: 7, url: "https://web.whatsapp.com/send?phone=5491112345678&type=phone_number", status: "complete" });
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();

    await expect(transport.waitForNavigationLifecycle(7, 1_000, undefined, {
      expectedPhoneDigits: "5491112345678",
      navigationRequestId: "nav-1",
      waitForComplete: true
    })).resolves.toMatchObject({ finalStatus: "complete", urlMatched: true });
    expect(mock.onUpdated.size()).toBe(0);
    expect(mock.onRemoved.size()).toBe(0);
  });

  it("waits through loading until complete when complete is explicitly required", async () => {
    const mock = chromeFor();
    mock.setTab({ id: 7, url: "https://web.whatsapp.com/send?phone=5491112345678", status: "loading" });
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForNavigationLifecycle(7, 2_000, undefined, {
      expectedPhoneDigits: "5491112345678",
      waitForComplete: true
    });
    await Promise.resolve();
    mock.onUpdated.emit(7, { status: "complete" }, {
      id: 7,
      url: "https://web.whatsapp.com/send?phone=5491112345678",
      status: "complete"
    });
    await expect(waiting).resolves.toMatchObject({ finalStatus: "complete" });
  });

  it("ignores lifecycle events from another tab", async () => {
    const mock = chromeFor();
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForNavigationLifecycle(7, 2_000, undefined, {
      expectedPhoneDigits: "5491112345678"
    });
    await Promise.resolve();
    mock.onUpdated.emit(8, { url: "https://web.whatsapp.com/send?phone=5491112345678" }, {
      id: 8,
      url: "https://web.whatsapp.com/send?phone=5491112345678",
      status: "loading"
    });
    expect(mock.onUpdated.size()).toBe(1);
    mock.onUpdated.emit(7, { url: "https://web.whatsapp.com/send?phone=5491112345678", status: "loading" }, {
      id: 7,
      url: "https://web.whatsapp.com/send?phone=5491112345678",
      status: "loading"
    });
    await expect(waiting).resolves.toMatchObject({ urlMatched: true });
  });

  it("fails closed when the bound tab is closed", async () => {
    const mock = chromeFor();
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForNavigationLifecycle(7, 2_000, undefined, { expectedPhoneDigits: "5491112345678" });
    await Promise.resolve();
    mock.onRemoved.emit(7);
    await expect(waiting).rejects.toMatchObject({ code: ERROR_CODES.whatsappNotOpen });
    expect(mock.onUpdated.size()).toBe(0);
  });

  it("aborts and removes listeners immediately", async () => {
    const mock = chromeFor();
    vi.stubGlobal("chrome", mock.chrome);
    const controller = new AbortController();
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForNavigationLifecycle(7, 2_000, controller.signal, { expectedPhoneDigits: "5491112345678" });
    await Promise.resolve();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.onUpdated.size()).toBe(0);
    expect(mock.onRemoved.size()).toBe(0);
  });

  it("times out and removes listeners", async () => {
    vi.useFakeTimers();
    const mock = chromeFor();
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForNavigationLifecycle(7, 500, undefined, { expectedPhoneDigits: "5491112345678" });
    const rejected = expect(waiting).rejects.toMatchObject({ code: ERROR_CODES.timeout, details: { stage: "navigation" } });
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(mock.onUpdated.size()).toBe(0);
    expect(mock.onRemoved.size()).toBe(0);
  });
});

describe("content handshake recovery", () => {
  it("classifies the two expected navigation receiver gaps as transient", () => {
    expect(classifyContentTransportFailure(new Error("Could not establish connection. Receiving end does not exist."))).toBe("RECEIVING_END_NOT_READY");
    expect(classifyContentTransportFailure(new Error("The message port closed before a response was received."))).toBe("MESSAGE_PORT_CLOSED_DURING_NAVIGATION");
  });

  it("retries a missing receiver and resolves as soon as the fresh content generation answers", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const sendMessage = vi.fn(async (_tabId: number, envelope: { requestId: string; payload: WhatsAppPreflightRequest }) => {
      attempt += 1;
      if (attempt === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { ok: true, requestId: envelope.requestId, data: handshakeFixture(envelope.payload, "content-new", false) };
    });
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForContentHandshake(7, 3_000, undefined, {
      previousContentInstanceId: "content-old",
      navigationRequestId: "nav-1"
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(waiting).resolves.toMatchObject({ contentInstanceId: "content-new", documentReady: false });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("retries a message-port closure during navigation", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const sendMessage = vi.fn(async (_tabId: number, envelope: { requestId: string; payload: WhatsAppPreflightRequest }) => {
      attempt += 1;
      if (attempt === 1) throw new Error("The message port closed before a response was received.");
      return { ok: true, requestId: envelope.requestId, data: handshakeFixture(envelope.payload, "content-new", false) };
    });
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForContentHandshake(7, 3_000, undefined, {
      previousContentInstanceId: "content-old",
      navigationRequestId: "nav-2"
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(waiting).resolves.toMatchObject({ contentInstanceId: "content-new" });
  });

  it("fails immediately on permission errors", async () => {
    const sendMessage = vi.fn(async () => { throw new Error("Missing host permission for the tab"); });
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    await expect(transport.waitForContentHandshake(7, 3_000, undefined, { navigationRequestId: "nav-3" }))
      .rejects.toMatchObject({ code: ERROR_CODES.protocolError, recoverable: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("fails immediately when the bound tab changed origin", async () => {
    const mock = chromeFor();
    mock.setTab({ id: 7, url: "https://example.com/", status: "complete" });
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    await expect(transport.waitForContentHandshake(7, 3_000, undefined, { navigationRequestId: "nav-4" }))
      .rejects.toMatchObject({ code: ERROR_CODES.protocolError, recoverable: false, details: { probeErrorKind: "WRONG_ORIGIN" } });
  });

  it("ignores the old generation until the post-navigation content script replies", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const sendMessage = vi.fn(async (_tabId: number, envelope: { requestId: string; payload: WhatsAppPreflightRequest }) => {
      attempt += 1;
      const id = attempt === 1 ? "content-old" : "content-new";
      return { ok: true, requestId: envelope.requestId, data: handshakeFixture(envelope.payload, id, false) };
    });
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForContentHandshake(7, 3_000, undefined, {
      previousContentInstanceId: "content-old",
      navigationRequestId: "nav-5"
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(waiting).resolves.toMatchObject({ contentInstanceId: "content-new" });
  });

  it("uses single-flight for the same tab and navigation request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sendMessage = vi.fn(async (_tabId: number, envelope: { requestId: string; payload: WhatsAppPreflightRequest }) => {
      await gate;
      return { ok: true, requestId: envelope.requestId, data: handshakeFixture(envelope.payload, "content-new", false) };
    });
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const options = { previousContentInstanceId: "content-old", navigationRequestId: "nav-single" };
    const first = transport.waitForContentHandshake(7, 3_000, undefined, options);
    const second = transport.waitForContentHandshake(7, 3_000, undefined, options);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.contentInstanceId).toBe("content-new");
    expect(b.contentInstanceId).toBe("content-new");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending handshake without waiting for its maximum budget", async () => {
    const sendMessage = vi.fn(() => new Promise(() => undefined));
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const controller = new AbortController();
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForContentHandshake(7, 40_000, controller.signal, { navigationRequestId: "nav-cancel" });
    await Promise.resolve();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports a safe timeout when the global handshake budget is exhausted", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(async (_tabId: number, envelope: { requestId: string; payload: WhatsAppPreflightRequest }) => ({
      ok: true,
      requestId: envelope.requestId,
      data: handshakeFixture(envelope.payload, "content-old", false)
    }));
    const mock = chromeFor(sendMessage);
    vi.stubGlobal("chrome", mock.chrome);
    const transport = new WhatsAppTransport();
    const waiting = transport.waitForContentHandshake(7, 900, undefined, {
      previousContentInstanceId: "content-old",
      navigationRequestId: "nav-timeout"
    });
    const rejected = expect(waiting).rejects.toMatchObject({
      code: ERROR_CODES.timeout,
      details: { stage: "content_handshake", contentGenerationChanged: false }
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  });
});
