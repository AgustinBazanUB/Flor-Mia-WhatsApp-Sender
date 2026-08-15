export interface SelectorMatch<T extends Element = HTMLElement> {
  element: T;
  strategy: string;
  selector: string;
}

interface SelectorGroup {
  strategy: string;
  selectors: readonly string[];
}

const groups = {
  appRoot: {
    strategy: "application-root",
    selectors: ["#app", "[data-testid='app']"]
  },
  qr: {
    strategy: "authentication-qr",
    selectors: [
      "[data-testid='qrcode']",
      "canvas[aria-label*='QR' i]",
      "div[data-ref] canvas",
      "[data-ref] canvas"
    ]
  },
  mainInterface: {
    strategy: "main-interface",
    selectors: [
      "#pane-side",
      "[data-testid='chat-list']",
      "[aria-label='Chat list']",
      "[aria-label='Lista de chats']",
      "header [data-testid='chat-list-header']"
    ]
  },
  composer: {
    strategy: "conversation-composer",
    selectors: [
      "#main footer [data-testid='conversation-compose-box-input'][contenteditable='true']",
      "#main footer div[contenteditable='true'][role='textbox']",
      "#main [data-lexical-editor='true'][contenteditable='true']",
      "#main footer div[contenteditable='true'][data-tab]"
    ]
  },
  sendButton: {
    strategy: "send-action",
    selectors: [
      "#main footer button[data-testid='compose-btn-send']",
      "#main footer button[aria-label='Send']",
      "#main footer button[aria-label='Enviar']",
      "#main footer [data-icon='send']"
    ]
  },
  invalidContact: {
    strategy: "invalid-contact-dialog",
    selectors: [
      "[data-testid='popup-contents'] [data-testid='alert-phone-number-invalid']",
      "[role='dialog'] [data-icon='alert-error']",
      "[role='dialog'] [data-testid='invalid-number']"
    ]
  },
  conversationHeader: {
    strategy: "conversation-header",
    selectors: [
      "#main header [data-testid='conversation-info-header']",
      "#main header [role='button'][title]",
      "#main header"
    ]
  }
} satisfies Record<string, SelectorGroup>;

function findFromGroup<T extends HTMLElement>(group: SelectorGroup, root: ParentNode = document): SelectorMatch<T> | null {
  for (const selector of group.selectors) {
    const raw = root.querySelector(selector);
    if (!raw) continue;
    const element = raw instanceof HTMLElement && raw.matches("[data-icon='send']") ? raw.closest("button") ?? raw : raw;
    if (element instanceof HTMLElement) return { element: element as T, strategy: group.strategy, selector };
  }
  return null;
}

export const findAppRoot = (root?: ParentNode): SelectorMatch | null => findFromGroup(groups.appRoot, root);
export const findQrCode = (root?: ParentNode): SelectorMatch | null => findFromGroup(groups.qr, root);
export const findMainInterface = (root?: ParentNode): SelectorMatch | null => findFromGroup(groups.mainInterface, root);
export const findComposer = (root?: ParentNode): SelectorMatch<HTMLElement> | null => findFromGroup(groups.composer, root);
export const findSendButton = (root?: ParentNode): SelectorMatch<HTMLButtonElement> | null => findFromGroup(groups.sendButton, root);
export const findInvalidContactDialog = (root?: ParentNode): SelectorMatch | null => findFromGroup(groups.invalidContact, root);
export const findConversationHeader = (root?: ParentNode): SelectorMatch | null => findFromGroup(groups.conversationHeader, root);

export interface OutgoingMessageSnapshot {
  identity: string;
  text: string;
  element: HTMLElement;
}

function normalizeMessageText(value: string): string {
  return value.replace(/\u200e|\u200f/g, "").replace(/\s+/g, " ").trim();
}

export function outgoingMessages(root: ParentNode = document): OutgoingMessageSnapshot[] {
  const candidates = root.querySelectorAll<HTMLElement>(
    "#main .message-out, #main [data-id^='true_'], #main [data-testid='msg-container']"
  );
  const seen = new Set<HTMLElement>();
  const result: OutgoingMessageSnapshot[] = [];
  for (const candidate of candidates) {
    const container = candidate.closest<HTMLElement>(".message-out, [data-id^='true_']") ?? candidate;
    const dataId = container.getAttribute("data-id") ?? "";
    const isOutgoing = container.classList.contains("message-out") || dataId.startsWith("true_");
    if (!isOutgoing || seen.has(container)) continue;
    seen.add(container);
    const textElement = container.querySelector<HTMLElement>("[data-testid='msg-text'], .selectable-text") ?? container;
    result.push({
      identity: dataId || container.id || `outgoing-${result.length}-${normalizeMessageText(textElement.textContent ?? "").length}`,
      text: normalizeMessageText(textElement.textContent ?? ""),
      element: container
    });
  }
  return result;
}

export function canonicalMessageText(value: string): string {
  return normalizeMessageText(value);
}
