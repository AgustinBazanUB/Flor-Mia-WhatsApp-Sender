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
