import json
from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    Path(path).write_text(value, encoding="utf-8")


def replace_required(path: str, old: str, new: str) -> None:
    source = read(path)
    if old not in source:
        raise RuntimeError(f"missing replacement in {path}: {old[:70]!r}")
    write(path, source.replace(old, new, 1))


def replace_section(path: str, start_marker: str, end_marker: str, replacement: str) -> None:
    source = read(path)
    start = source.find(start_marker)
    if start < 0:
        raise RuntimeError(f"missing section start in {path}: {start_marker[:70]!r}")
    end = source.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f"missing section end in {path}: {end_marker[:70]!r}")
    write(path, source[:start] + replacement + source[end:])


helper = read("scripts/apply-p0-handshake-fix.mjs")


def extract(name: str, end_marker: str) -> str:
    prefix = f"const {name} = String.raw`"
    start = helper.find(prefix)
    if start < 0:
        raise RuntimeError(f"missing embedded block {name}")
    start += len(prefix)
    end = helper.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f"missing embedded block end {name}")
    return helper[start:end]


print("phase=extract")
transport = extract("transportSource", "`;\n\nconst openConversationSource = String.raw`")
open_conversation = extract("openConversationSource", "`;\n\nfunction patchCore()")
lifecycle_tests = extract("lifecycleTestSource", "`;\n\nfunction patchTests()")
transport = transport.replace("chrome.tabs.TabStatus | null", 'chrome.tabs.Tab["status"] | null')

handshake_marker = '    const handshakeAt = new Date().toISOString();'
handshake_guard = '''    const handshakeContentInstanceId = handshake.contentInstanceId;
    if (!handshakeContentInstanceId) {
      throw new ExtensionError(ERROR_CODES.protocolError, "El Content Script nuevo no informó su generación después de la navegación.", {
        recoverable: false,
        details: { stage: "content_handshake", navigationRequestId: pending.navigationRequestId }
      });
    }
    const handshakeAt = new Date().toISOString();'''
if handshake_marker not in open_conversation:
    raise RuntimeError("missing handshake marker in contact adapter source")
open_conversation = open_conversation.replace(handshake_marker, handshake_guard, 1)
open_conversation = open_conversation.replace(
    '      newContentGeneration: handshake.contentInstanceId ?? null,',
    '      newContentGeneration: handshakeContentInstanceId,',
    1,
)
open_conversation = open_conversation.replace(
    '        expectedContentInstanceId: handshake.contentInstanceId,',
    '        expectedContentInstanceId: handshakeContentInstanceId,',
    1,
)

old_event_helper = '''function event<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: vi.fn((listener: T) => listeners.add(listener)),
    removeListener: vi.fn((listener: T) => listeners.delete(listener)),
    emit: (...args: Parameters<T>) => [...listeners].forEach((listener) => listener(...args)),
    size: () => listeners.size
  };
}'''
new_event_helper = '''function event<TArgs extends unknown[]>() {
  type Listener = (...args: TArgs) => void;
  const listeners = new Set<Listener>();
  return {
    addListener: vi.fn((listener: Listener) => listeners.add(listener)),
    removeListener: vi.fn((listener: Listener) => listeners.delete(listener)),
    emit: (...args: TArgs) => [...listeners].forEach((listener) => listener(...args)),
    size: () => listeners.size
  };
}'''
if old_event_helper not in lifecycle_tests:
    raise RuntimeError("missing event helper in lifecycle tests")
lifecycle_tests = lifecycle_tests.replace(old_event_helper, new_event_helper, 1)
lifecycle_tests = lifecycle_tests.replace(
    'event<(tabId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void>()',
    'event<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>()',
)
lifecycle_tests = lifecycle_tests.replace(
    'event<(tabId: number) => void>()',
    'event<[number]>()',
)

print("phase=transport")
write("src/background/whatsapp-transport.ts", transport)

print("phase=types-preflight-policy")
replace_required(
    "src/compatibility/types.ts",
    'export type PreflightPurpose = "campaign_start" | "health_check" | "content_handshake" | "manual_diagnostic" | "unspecified";',
    'export type PreflightPurpose = "campaign_start" | "health_check" | "content_handshake" | "semantic_ready" | "manual_diagnostic" | "unspecified";',
)
replace_required(
    "src/whatsapp/preflight.ts",
    '  const pageDetected = window.location.origin === "https://web.whatsapp.com";\n\n  let readinessSignal:',
    '  const pageDetected = window.location.origin === "https://web.whatsapp.com";\n  const handshakeOnly = request.purpose === "content_handshake" && level === "lightweight";\n\n  let readinessSignal:',
)
replace_required(
    "src/whatsapp/preflight.ts",
    "  if (pageDetected && !documentReady) {",
    "  if (pageDetected && !documentReady && !handshakeOnly) {",
)
replace_required(
    "src/whatsapp/preflight.ts",
    '  if (pageDetected && documentReady && !findQrCode() && !resolveCapability("main_interface").match && !findComposer()) {',
    '  if (!handshakeOnly && pageDetected && documentReady && !findQrCode() && !resolveCapability("main_interface").match && !findComposer()) {',
)
replace_required(
    "src/whatsapp/preflight.ts",
    '  if (pageDetected && documentReady && inspectConversation && request.targetedCapability && !findQrCode() && !findComposer()) {',
    '  if (!handshakeOnly && pageDetected && documentReady && inspectConversation && request.targetedCapability && !findQrCode() && !findComposer()) {',
)
replace_required("src/engine/retry-policy.ts", "    openConversationMs: 30_000,", "    openConversationMs: 40_000,")

print("phase=contact-adapter")
replace_required(
    "src/background/contact-adapter.ts",
    '    stage: "navigation" | "content_handshake" | "conversation_proof",',
    '    stage: "navigation" | "content_handshake" | "semantic_ready" | "conversation_proof",',
)
replace_required(
    "src/background/contact-adapter.ts",
    "  navigationRequestedMs: number;\n}",
    "  navigationRequestedMs: number;\n  navigationObservedAt?: string;\n  tabLoadingAt?: string | null;\n  tabCompleteAt?: string | null;\n}",
)
replace_section(
    "src/background/contact-adapter.ts",
    "  async openConversation(\n",
    "\n  private requireBoundTabId(): number {",
    open_conversation,
)

print("phase=service-worker")
sw_start = "    const navigation = await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, {"
sw_end = "    await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappProveConversation, {"
sw_new = '''    const openDeadlineMs = Date.now() + 40_000;
    const remainingOpenBudget = () => Math.max(1, openDeadlineMs - Date.now());
    const navigation = await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, {
      operationId,
      phoneDigits: phone.digits,
      navigationRequestId
    }, tab.id);
    await stateStore.patch({
      currentStep: "wait-conversation",
      lastCheckpoint: { operationId, recipientId: operationId, step: "navigation-requested", createdAt: new Date().toISOString() }
    });
    const lifecycle = await whatsappTransport.waitForNavigationLifecycle(
      tab.id,
      Math.min(10_000, remainingOpenBudget()),
      undefined,
      { expectedPhoneDigits: phone.digits, navigationRequestId }
    );
    const handshake = await whatsappTransport.waitForContentHandshake(tab.id, remainingOpenBudget(), undefined, {
      previousContentInstanceId: navigation.contentInstanceId,
      purpose: "content_handshake",
      navigationRequestId
    });
    if (!handshake.contentInstanceId) {
      throw new ExtensionError(ERROR_CODES.protocolError, "El Content Script nuevo no informó su generación después de la navegación.", {
        recoverable: false,
        details: { stage: "content_handshake", navigationRequestId }
      });
    }
    const readiness = await whatsappTransport.waitForSemanticReady(tab.id, remainingOpenBudget(), undefined, {
      expectedContentInstanceId: handshake.contentInstanceId,
      navigationRequestId
    });
    const navigationObservedAt = lifecycle.observedAt;
'''
replace_section("src/background/service-worker.ts", sw_start, sw_end, sw_new)

print("phase=tests")
test_path = "tests/contact-adapter-binding.test.ts"
source = read(test_path)
marker = "function checkpoint() {"
if marker not in source:
    raise RuntimeError("missing checkpoint marker in contact-adapter-binding.test.ts")
helper_text = '''function withLifecycle<T extends Record<string, unknown>>(transport: T) {
  const legacyWait = (transport as { waitForContent?: (...args: unknown[]) => Promise<unknown> }).waitForContent;
  return {
    waitForNavigationLifecycle: async () => ({
      observedAt: NOW,
      loadingAt: NOW,
      completeAt: NOW,
      finalStatus: "complete" as const,
      urlMatched: true
    }),
    waitForContentHandshake: async (tabId: number, timeoutMs: number, signal: AbortSignal | undefined, options: {
      previousContentInstanceId?: string;
      navigationRequestId?: string;
    }) => legacyWait
      ? legacyWait(tabId, timeoutMs, signal, {
          previousContentInstanceId: options.previousContentInstanceId,
          purpose: "content_handshake"
        })
      : green("content-new"),
    waitForSemanticReady: async (_tabId: number, _timeoutMs: number, _signal: AbortSignal | undefined, options: {
      expectedContentInstanceId?: string;
    }) => green(options.expectedContentInstanceId ?? "content-new"),
    ...transport
  };
}

'''
source = source.replace(marker, helper_text + marker, 1)
source = source.replace(
    "fakeTransport as unknown as WhatsAppTransport",
    "withLifecycle(fakeTransport) as unknown as WhatsAppTransport",
)
write(test_path, source)
write("tests/post-navigation-handshake.test.ts", lifecycle_tests)

print("phase=version")
manifest = json.loads(read("manifest.json"))
manifest["version"] = "0.9.4.1"
manifest["version_name"] = "0.9.4.1"
write("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
package = json.loads(read("package.json"))
package["version"] = "0.9.4.1"
write("package.json", json.dumps(package, indent=2, ensure_ascii=False) + "\n")
lock = json.loads(read("package-lock.json"))
lock["version"] = "0.9.4.1"
if isinstance(lock.get("packages"), dict) and isinstance(lock["packages"].get(""), dict):
    lock["packages"][""]["version"] = "0.9.4.1"
write("package-lock.json", json.dumps(lock, indent=2, ensure_ascii=False) + "\n")
print("phase=done")
