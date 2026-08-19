import type {
  CandidateSummary,
  CapabilityDiscovery,
  StrategyAttempt,
  WhatsAppCapability
} from "../compatibility/types";

export interface SelectorMatch<T extends Element = HTMLElement> {
  element: T;
  strategy: string;
  selector: string;
}

interface SelectorStrategy {
  id: string;
  method: "accessibility" | "semantic-attribute" | "structural" | "data-testid" | "data-icon" | "css-fallback";
  priority: number;
  selector: string;
}

interface SelectorCapabilityDefinition {
  logicalStep: string;
  expectedSemanticElement: string;
  strategies: readonly SelectorStrategy[];
}

export interface CapabilityResolverOptions {
  required?: boolean;
  disablePrimary?: boolean;
  forceUnavailable?: boolean;
}

export interface CapabilityResolution<T extends HTMLElement = HTMLElement> {
  match: SelectorMatch<T> | null;
  discovery: CapabilityDiscovery;
}

export const UI_LABELS = {
  send: ["Send", "Enviar"],
  attach: ["Attach", "Adjuntar"],
  close: ["Close", "Cerrar"],
  chatList: ["Chat list", "Lista de chats"]
} as const;

function labelSelectors(tag: string, labels: readonly string[]): string[] {
  return labels.map((label) => `${tag}[aria-label='${label}']`);
}

const selectorRegistry = {
  main_interface: {
    logicalStep: "preflight.main_interface",
    expectedSemanticElement: "lista o área principal de WhatsApp",
    strategies: [
      ...labelSelectors("", UI_LABELS.chatList).map((selector, index) => ({
        id: `main.accessibility.${index + 1}`, method: "accessibility" as const, priority: 10 + index, selector
      })),
      { id: "main.testid.chat-list", method: "data-testid", priority: 30, selector: "[data-testid='chat-list']" },
      { id: "main.structural.pane-side", method: "structural", priority: 40, selector: "#pane-side" },
      { id: "main.testid.header", method: "data-testid", priority: 50, selector: "header [data-testid='chat-list-header']" }
    ]
  },
  composer: {
    logicalStep: "conversation.composer",
    expectedSemanticElement: "editor de texto editable de la conversación",
    strategies: [
      { id: "composer.accessibility.textbox", method: "accessibility", priority: 10, selector: "#main footer [role='textbox'][contenteditable='true']" },
      { id: "composer.testid.compose-input", method: "data-testid", priority: 20, selector: "#main footer [data-testid='conversation-compose-box-input'][contenteditable='true']" },
      { id: "composer.semantic.lexical", method: "semantic-attribute", priority: 30, selector: "#main [data-lexical-editor='true'][contenteditable='true']" },
      { id: "composer.structural.footer-editable", method: "structural", priority: 40, selector: "#main footer div[contenteditable='true'][data-tab]" }
    ]
  },
  text_send_action: {
    logicalStep: "text.send_action",
    expectedSemanticElement: "botón semántico de envío de texto",
    strategies: [
      ...labelSelectors("#main footer button", UI_LABELS.send).map((selector, index) => ({
        id: `text-send.accessibility.${index + 1}`, method: "accessibility" as const, priority: 10 + index, selector
      })),
      { id: "text-send.testid.compose", method: "data-testid", priority: 30, selector: "#main footer button[data-testid='compose-btn-send']" },
      { id: "text-send.icon.send", method: "data-icon", priority: 40, selector: "#main footer [data-icon='send']" }
    ]
  },
  attachment_action: {
    logicalStep: "image.attachment_action",
    expectedSemanticElement: "botón semántico para abrir adjuntos",
    strategies: [
      ...labelSelectors("#main footer button", UI_LABELS.attach).map((selector, index) => ({
        id: `attach.accessibility.${index + 1}`, method: "accessibility" as const, priority: 10 + index, selector
      })),
      { id: "attach.testid.clip", method: "data-testid", priority: 30, selector: "#main footer button[data-testid='clip']" },
      { id: "attach.icon.plus-rounded", method: "data-icon", priority: 40, selector: "#main footer [data-icon='plus-rounded']" },
      { id: "attach.icon.clip", method: "data-icon", priority: 50, selector: "#main footer [data-icon='clip']" }
    ]
  },
  image_file_input: {
    logicalStep: "image.file_input",
    expectedSemanticElement: "input de archivo que acepte imágenes",
    strategies: [
      { id: "image-input.semantic.accept", method: "semantic-attribute", priority: 10, selector: "input[type='file'][accept^='image/'], input[type='file'][accept*='image/*']" },
      { id: "image-input.structural.main", method: "structural", priority: 20, selector: "#main input[type='file'][accept*='image']" },
      { id: "image-input.structural.dialog", method: "structural", priority: 30, selector: "[role='dialog'] input[type='file'][accept*='image']" }
    ]
  },
  media_preview: {
    logicalStep: "image.media_preview",
    expectedSemanticElement: "preview multimedia preparado antes del envío",
    strategies: [
      { id: "media-preview.accessibility.dialog", method: "accessibility", priority: 10, selector: "[role='dialog'][aria-label*='preview' i]" },
      { id: "media-preview.testid.editor", method: "data-testid", priority: 20, selector: "[data-testid='media-editor']" },
      { id: "media-preview.testid.editor-canvas", method: "data-testid", priority: 30, selector: "[data-testid='media-editor-canvas']" },
      { id: "media-preview.testid.preview", method: "data-testid", priority: 40, selector: "[data-testid='media-preview']" },
      { id: "media-preview.structural.dialog-media", method: "structural", priority: 50, selector: "[role='dialog'] [data-testid*='media' i]" },
      { id: "media-preview.semantic.animate", method: "semantic-attribute", priority: 60, selector: "[data-animate-media-viewer='true']" }
    ]
  },
  media_send_action: {
    logicalStep: "image.media_send_action",
    expectedSemanticElement: "botón semántico de envío del preview multimedia",
    strategies: [
      ...labelSelectors("button", UI_LABELS.send).map((selector, index) => ({
        id: `media-send.accessibility.${index + 1}`, method: "accessibility" as const, priority: 10 + index, selector
      })),
      { id: "media-send.testid.editor", method: "data-testid", priority: 30, selector: "button[data-testid='media-editor-send']" },
      { id: "media-send.testid.compose", method: "data-testid", priority: 40, selector: "button[data-testid='compose-btn-send']" },
      { id: "media-send.icon.send", method: "data-icon", priority: 50, selector: "[data-icon='send']" }
    ]
  },
  outgoing_text_evidence: {
    logicalStep: "text.outgoing_evidence",
    expectedSemanticElement: "contenedor de conversación observable para evidencia saliente de texto",
    strategies: [
      { id: "outgoing-text.semantic.data-id", method: "semantic-attribute", priority: 10, selector: "#main [data-id^='true_']" },
      { id: "outgoing-text.testid.message", method: "data-testid", priority: 20, selector: "#main [data-testid='msg-container']" },
      { id: "outgoing-text.structural.root", method: "structural", priority: 30, selector: "#main" }
    ]
  },
  outgoing_media_evidence: {
    logicalStep: "image.outgoing_evidence",
    expectedSemanticElement: "contenedor de conversación observable para evidencia multimedia saliente",
    strategies: [
      { id: "outgoing-media.testid.thumbnail", method: "data-testid", priority: 10, selector: "#main [data-testid='image-thumb'], #main [data-testid='video-thumb']" },
      { id: "outgoing-media.semantic.data-id", method: "semantic-attribute", priority: 20, selector: "#main [data-id^='true_']" },
      { id: "outgoing-media.structural.root", method: "structural", priority: 30, selector: "#main" }
    ]
  }
} satisfies Partial<Record<WhatsAppCapability, SelectorCapabilityDefinition>>;

export const SELECTOR_REGISTRY = selectorRegistry;

const internalGroups = {
  appRoot: ["#app", "[data-testid='app']"],
  qr: ["[data-testid='qrcode']", "canvas[aria-label*='QR' i]", "div[data-ref] canvas", "[data-ref] canvas"],
  invalidContact: [
    "[data-testid='popup-contents'] [data-testid='alert-phone-number-invalid']",
    "[role='dialog'] [data-icon='alert-error']",
    "[role='dialog'] [data-testid='invalid-number']"
  ],
  conversationHeader: ["#main header [data-testid='conversation-info-header']", "#main header [role='button'][title]", "#main header"],
  mediaPreviewClose: [
    ...labelSelectors("button", UI_LABELS.close),
    "button[data-testid='media-editor-close']",
    "[data-icon='x']",
    "[data-icon='x-alt']"
  ]
} as const;

function redactSensitiveValue(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!normalized) return "";
  if (/\+?\d[\d\s().-]{5,}/.test(normalized)) return "[redacted]";
  return normalized;
}

const SAFE_ARIA_TERMS = /send|enviar|attach|adjuntar|close|cerrar|chat|message|mensaje|image|imagen|photo|foto|video|search|buscar|type|escribe/i;

function safeAriaLabel(element: Element): string | undefined {
  const value = redactSensitiveValue(element.getAttribute("aria-label") ?? "");
  if (!value) return undefined;
  return SAFE_ARIA_TERMS.test(value) ? value : "[redacted]";
}

function safeAttribute(element: Element, name: string): string | undefined {
  const value = redactSensitiveValue(element.getAttribute(name) ?? "");
  return value || undefined;
}

function hierarchyHint(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  for (let depth = 0; current && depth < 3; depth += 1, current = current.parentElement) {
    const role = safeAttribute(current, "role");
    const testId = safeAttribute(current, "data-testid");
    const icon = safeAttribute(current, "data-icon");
    parts.unshift(`${current.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}${testId ? `[testid=${testId}]` : ""}${icon ? `[icon=${icon}]` : ""}`);
  }
  return parts.join(" > ").slice(0, 160);
}

export function describeCandidate(element: Element): CandidateSummary {
  return {
    tagName: element.tagName.toLowerCase(),
    ...(safeAttribute(element, "role") ? { role: safeAttribute(element, "role") } : {}),
    ...(safeAriaLabel(element) ? { ariaLabel: safeAriaLabel(element) } : {}),
    ...(safeAttribute(element, "data-testid") ? { dataTestId: safeAttribute(element, "data-testid") } : {}),
    ...(safeAttribute(element, "data-icon") ? { dataIcon: safeAttribute(element, "data-icon") } : {}),
    ...(safeAttribute(element, "type") ? { type: safeAttribute(element, "type") } : {}),
    ...(safeAttribute(element, "contenteditable") ? { contentEditable: safeAttribute(element, "contenteditable") } : {}),
    hierarchyHint: hierarchyHint(element)
  };
}

function asActionElement(element: Element): Element {
  return element.matches("[data-icon]") ? element.closest("button, [role='button']") ?? element : element;
}

function uniqueElements(elements: Element[]): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const result: HTMLElement[] = [];
  for (const raw of elements) {
    const element = asActionElement(raw);
    if (!(element instanceof HTMLElement) || seen.has(element)) continue;
    seen.add(element);
    result.push(element);
  }
  return result;
}

function semanticFingerprint(element: Element, strategy: SelectorStrategy): string {
  const summary = describeCandidate(element);
  return [
    summary.tagName,
    `role=${summary.role ?? ""}`,
    `testid=${summary.dataTestId ?? ""}`,
    `icon=${summary.dataIcon ?? ""}`,
    `type=${summary.type ?? ""}`,
    `editable=${summary.contentEditable ?? ""}`,
    `method=${strategy.method}`
  ].join("|");
}

export function resolveCapability<T extends HTMLElement = HTMLElement>(
  capability: keyof typeof selectorRegistry,
  root: ParentNode = document,
  options: CapabilityResolverOptions = {}
): CapabilityResolution<T> {
  const definition = selectorRegistry[capability];
  const attempts: StrategyAttempt[] = [];
  let match: SelectorMatch<T> | null = null;
  let selectedElement: HTMLElement | null = null;
  let selectedStrategy: SelectorStrategy | null = null;
  const allCandidates: CandidateSummary[] = [];
  const uniqueCandidateElements = new Set<HTMLElement>();

  for (const [index, strategy] of definition.strategies.entries()) {
    const disabled = options.forceUnavailable || (options.disablePrimary && index === 0);
    if (disabled) {
      attempts.push({
        strategyId: strategy.id,
        method: strategy.method,
        priority: strategy.priority,
        result: "disabled",
        matchedCount: 0,
        candidates: []
      });
      continue;
    }
    const candidates = uniqueElements([...root.querySelectorAll(strategy.selector)]);
    for (const candidate of candidates) uniqueCandidateElements.add(candidate);
    const summaries = candidates.slice(0, 5).map(describeCandidate);
    allCandidates.push(...summaries);
    const selected = candidates.find(elementVisible) ?? candidates[0] ?? null;
    attempts.push({
      strategyId: strategy.id,
      method: strategy.method,
      priority: strategy.priority,
      result: selected ? "matched" : "not_found",
      matchedCount: candidates.length,
      ...(selected ? { selectedCandidate: describeCandidate(selected) } : {}),
      candidates: summaries
    });
    if (!selected) continue;
    selectedElement = selected;
    selectedStrategy = strategy;
    match = { element: selected as T, strategy: strategy.id, selector: strategy.selector };
    break;
  }

  const dedupedCandidates = allCandidates.filter((candidate, index, values) => values.findIndex((value) => JSON.stringify(value) === JSON.stringify(candidate)) === index).slice(0, 8);
  return {
    match,
    discovery: {
      capability,
      logicalStep: definition.logicalStep,
      state: match ? "available" : "unavailable",
      required: options.required ?? false,
      message: match
        ? `Capability resuelta mediante ${selectedStrategy!.id}.`
        : "Ninguna estrategia registrada encontró un elemento funcional.",
      expectedSemanticElement: definition.expectedSemanticElement,
      ...(selectedStrategy ? { selectedStrategy: selectedStrategy.id } : {}),
      attempts,
      candidateCount: uniqueCandidateElements.size,
      candidateSummaries: dedupedCandidates,
      ...(selectedElement && selectedStrategy ? {
        fingerprint: {
          strategyId: selectedStrategy.id,
          method: selectedStrategy.method,
          tagName: selectedElement.tagName.toLowerCase(),
          ...(safeAttribute(selectedElement, "role") ? { role: safeAttribute(selectedElement, "role") } : {}),
          attributes: Object.fromEntries([
            ["aria-label", safeAriaLabel(selectedElement)],
            ["data-testid", safeAttribute(selectedElement, "data-testid")],
            ["data-icon", safeAttribute(selectedElement, "data-icon")],
            ["type", safeAttribute(selectedElement, "type")],
            ["contenteditable", safeAttribute(selectedElement, "contenteditable")]
          ].filter((entry): entry is [string, string] => Boolean(entry[1]))),
          semanticFingerprint: semanticFingerprint(selectedElement, selectedStrategy)
        }
      } : {}),
      change: "unknown"
    }
  };
}

function findInternal<T extends HTMLElement>(group: keyof typeof internalGroups, root: ParentNode = document): SelectorMatch<T> | null {
  for (const selector of internalGroups[group]) {
    const raw = root.querySelector(selector);
    if (!raw) continue;
    const element = asActionElement(raw);
    if (element instanceof HTMLElement) return { element: element as T, strategy: `${group}.${selector}`, selector };
  }
  return null;
}

export const findAppRoot = (root?: ParentNode): SelectorMatch | null => findInternal("appRoot", root);
export const findQrCode = (root?: ParentNode): SelectorMatch | null => findInternal("qr", root);
export const findMainInterface = (root?: ParentNode): SelectorMatch | null => resolveCapability("main_interface", root).match;
export const findComposer = (root?: ParentNode): SelectorMatch<HTMLElement> | null => resolveCapability("composer", root).match;
export const findSendButton = (root?: ParentNode): SelectorMatch<HTMLButtonElement> | null => resolveCapability<HTMLButtonElement>("text_send_action", root).match;
export const findAttachButton = (root?: ParentNode): SelectorMatch<HTMLButtonElement> | null => resolveCapability<HTMLButtonElement>("attachment_action", root).match;
export const findImageFileInput = (root?: ParentNode): SelectorMatch<HTMLInputElement> | null => resolveCapability<HTMLInputElement>("image_file_input", root).match;
export const findMediaPreview = (root?: ParentNode): SelectorMatch<HTMLElement> | null => resolveCapability("media_preview", root).match;
export const findMediaSendButton = (root?: ParentNode): SelectorMatch<HTMLButtonElement> | null => resolveCapability<HTMLButtonElement>("media_send_action", root).match;
export const findMediaPreviewCloseButton = (root?: ParentNode): SelectorMatch<HTMLButtonElement> | null => findInternal("mediaPreviewClose", root);
export const findInvalidContactDialog = (root?: ParentNode): SelectorMatch | null => findInternal("invalidContact", root);
export const findConversationHeader = (root?: ParentNode): SelectorMatch | null => findInternal("conversationHeader", root);

export interface OutgoingMessageSnapshot {
  identity: string;
  stableIdentity: boolean;
  text: string;
  element: HTMLElement;
}

export interface OutgoingMediaSnapshot {
  identity: string;
  stableIdentity: boolean;
  element: HTMLElement;
}

function normalizeMessageText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200e\u200f]/g, "")
    .replace(/\u00a0/g, " ");
}

export function outgoingMessages(root: ParentNode = document): OutgoingMessageSnapshot[] {
  const selector = ".message-out, [data-id^='true_'], [data-testid='msg-container']";
  const candidates: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(selector)) candidates.push(root);
  if ("querySelectorAll" in root) candidates.push(...root.querySelectorAll<HTMLElement>(selector));
  const seen = new Set<HTMLElement>();
  const result: OutgoingMessageSnapshot[] = [];
  for (const candidate of candidates) {
    const bubble = candidate.classList.contains("message-out")
      ? candidate
      : candidate.querySelector<HTMLElement>(".message-out") ?? candidate.closest<HTMLElement>(".message-out") ?? candidate;
    const stableContainer = bubble.closest<HTMLElement>("[data-id^='true_']")
      ?? (candidate.matches("[data-id^='true_']") ? candidate : candidate.closest<HTMLElement>("[data-id^='true_']"));
    const dataId = stableContainer?.getAttribute("data-id") ?? "";
    const isOutgoing = bubble.classList.contains("message-out") || dataId.startsWith("true_");
    if (!isOutgoing || seen.has(bubble)) continue;
    seen.add(bubble);
    const textElement = bubble.querySelector<HTMLElement>("[data-testid='msg-text'], .selectable-text") ?? bubble;
    const stableIdentity = dataId || bubble.id || "";
    result.push({
      identity: stableIdentity || `observation-outgoing-${result.length}-${normalizeMessageText(textElement.textContent ?? "").length}`,
      stableIdentity: Boolean(stableIdentity),
      text: normalizeMessageText(textElement.textContent ?? ""),
      element: bubble
    });
  }
  return result;
}

export function outgoingMediaMessages(root: ParentNode = document): OutgoingMediaSnapshot[] {
  const candidates = root.querySelectorAll<HTMLElement>(
    "#main .message-out, #main [data-id^='true_'], #main [data-testid='msg-container']"
  );
  const seen = new Set<HTMLElement>();
  const result: OutgoingMediaSnapshot[] = [];
  for (const candidate of candidates) {
    const container = candidate.closest<HTMLElement>(".message-out, [data-id^='true_']") ?? candidate;
    const dataId = container.getAttribute("data-id") ?? "";
    const isOutgoing = container.classList.contains("message-out") || dataId.startsWith("true_");
    if (!isOutgoing || seen.has(container)) continue;
    const media = container.querySelector(
      "[data-testid='image-thumb'], [data-testid='video-thumb'], [data-testid*='media' i], img[src^='blob:'], img[src^='data:'], video, canvas"
    );
    if (!media) continue;
    seen.add(container);
    const stableIdentity = dataId || container.id;
    result.push({
      identity: stableIdentity || `observation-outgoing-media-${result.length}`,
      stableIdentity: Boolean(stableIdentity),
      element: container
    });
  }
  return result;
}

export function elementVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = globalThis.getComputedStyle?.(element);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

export function canonicalMessageText(value: string): string {
  return normalizeMessageText(value);
}
