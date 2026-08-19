from pathlib import Path

test_path = Path("tests/post-navigation-handshake.test.ts")
source = test_path.read_text(encoding="utf-8")
old = '''function chromeFor(sendMessage = vi.fn()) {
  const onUpdated = event<[number, TestTabChangeInfo, chrome.tabs.Tab]>();
  const onRemoved = event<[number]>();
  let current = { id: 7, url: "https://web.whatsapp.com/", status: "complete" as const };
  const get = vi.fn(async () => current);
  return {
    onUpdated,
    onRemoved,
    setTab(tab: typeof current) { current = tab; },
'''
new = '''type TestTab = {
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
'''
if old not in source:
    raise RuntimeError("expected chromeFor test block was not found")
source = source.replace(old, new, 1)

old_navigation_timeout = '''    const waiting = transport.waitForNavigationLifecycle(7, 500, undefined, { expectedPhoneDigits: "5491112345678" });
    await vi.advanceTimersByTimeAsync(500);
    await expect(waiting).rejects.toMatchObject({ code: ERROR_CODES.timeout, details: { stage: "navigation" } });'''
new_navigation_timeout = '''    const waiting = transport.waitForNavigationLifecycle(7, 500, undefined, { expectedPhoneDigits: "5491112345678" });
    const rejected = expect(waiting).rejects.toMatchObject({ code: ERROR_CODES.timeout, details: { stage: "navigation" } });
    await vi.advanceTimersByTimeAsync(500);
    await rejected;'''
if old_navigation_timeout not in source:
    raise RuntimeError("expected navigation timeout test block was not found")
source = source.replace(old_navigation_timeout, new_navigation_timeout, 1)

old_handshake_timeout = '''    const waiting = transport.waitForContentHandshake(7, 900, undefined, {
      previousContentInstanceId: "content-old",
      navigationRequestId: "nav-timeout"
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).rejects.toMatchObject({
      code: ERROR_CODES.timeout,
      details: { stage: "content_handshake", contentGenerationChanged: false }
    });'''
new_handshake_timeout = '''    const waiting = transport.waitForContentHandshake(7, 900, undefined, {
      previousContentInstanceId: "content-old",
      navigationRequestId: "nav-timeout"
    });
    const rejected = expect(waiting).rejects.toMatchObject({
      code: ERROR_CODES.timeout,
      details: { stage: "content_handshake", contentGenerationChanged: false }
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;'''
if old_handshake_timeout not in source:
    raise RuntimeError("expected handshake timeout test block was not found")
source = source.replace(old_handshake_timeout, new_handshake_timeout, 1)
test_path.write_text(source, encoding="utf-8")

transport_path = Path("src/background/whatsapp-transport.ts")
transport = transport_path.read_text(encoding="utf-8")
old_guard = '''    if (!chrome.tabs.onUpdated?.addListener) {
      await abortableDelay(delayMs, signal);
      return;
    }'''
new_guard = '''    if (typeof chrome === "undefined" || !chrome.tabs?.onUpdated?.addListener) {
      await abortableDelay(delayMs, signal);
      return;
    }'''
if old_guard not in transport:
    raise RuntimeError("expected waitForProbeOpportunity fallback was not found")
transport = transport.replace(old_guard, new_guard, 1)
transport_path.write_text(transport, encoding="utf-8")
