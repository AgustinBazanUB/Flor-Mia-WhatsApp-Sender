import { ERROR_CODES, ExtensionError, toExtensionError } from "../shared/errors";
import { capabilityResolutionError, capabilityUnavailableError } from "../compatibility/diagnostic-error";
import { maskPhone } from "../shared/phone";
import type { TextTestResult, TextVerification } from "../shared/state";
import {
  canonicalMessageText,
  findComposer,
  findInvalidContactDialog,
  findSendButton,
  outgoingMessages,
  resolveCapability,
  type OutgoingMessageSnapshot
} from "./selectors";
import { waitForCondition } from "./wait";
import { requireConversationContext } from "./conversation-context";

const POST_CLICK_VERIFICATION_BUDGET_MS = 6_000;
const STRONG_ID_GRACE_MS = 100;

async function contactIdForPhone(phoneDigits: string): Promise<string> {
  const data = new TextEncoder().encode(`flor-mia-test-contact:${phoneDigits}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const id = [...new Uint8Array(digest)].slice(0, 10).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `contact-${id}`;
}

export function normalizeComposerLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function composerTextRepresentations(composer: HTMLElement): string[] {
  const values = [composer.innerText, composer.textContent]
    .filter((value): value is string => typeof value === "string")
    .map(normalizeComposerLineEndings);
  return [...new Set(values)];
}

export type ComposerPreparationState = "empty" | "prepared" | "conflict";

export function classifyComposerContent(existingText: string, expectedText: string): ComposerPreparationState {
  const existing = normalizeComposerLineEndings(existingText);
  const expected = normalizeComposerLineEndings(expectedText);
  if (!canonicalMessageText(existing).trim()) return "empty";
  return existing === expected ? "prepared" : "conflict";
}

function classifyComposerElementContent(composer: HTMLElement, expectedText: string): ComposerPreparationState {
  const expected = normalizeComposerLineEndings(expectedText);
  const representations = composerTextRepresentations(composer);
  if (representations.some((value) => value === expected)) return "prepared";
  if (representations.every((value) => !canonicalMessageText(value).trim())) return "empty";
  return "conflict";
}

async function waitForPreparedComposer(expected: string, fallbackComposer: HTMLElement, timeoutMs = 1_000): Promise<HTMLElement | null> {
  return waitForCondition(() => {
    const live = findComposer()?.element ?? (fallbackComposer.isConnected ? fallbackComposer : null);
    if (!live) return null;
    return classifyComposerElementContent(live, expected) === "prepared" ? live : null;
  }, { timeoutMs, description: "que WhatsApp estabilice el texto preparado en el composer" }).catch(() => null);
}

export async function prepareComposerTextForSend(composer: HTMLElement, message: string): Promise<"inserted" | "reused"> {
  const expected = normalizeComposerLineEndings(message);
  const state = classifyComposerElementContent(composer, expected);
  if (state === "prepared") return "reused";
  if (state === "conflict") {
    throw new ExtensionError(ERROR_CODES.invalidInput, "La conversación tiene un borrador diferente. Vacialo manualmente antes de continuar para no sobrescribirlo.", {
      recoverable: true, details: { sendAttempted: false, draftConflict: true }
    });
  }
  composer.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);
  const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, expected);
  let prepared = await waitForPreparedComposer(expected, composer, inserted ? 800 : 50);
  if (!prepared) {
    const liveComposer = findComposer()?.element ?? composer;
    liveComposer.focus();
    liveComposer.replaceChildren(document.createTextNode(expected));
    const event = typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: expected })
      : new Event("input", { bubbles: true });
    liveComposer.dispatchEvent(event);
    prepared = await waitForPreparedComposer(expected, liveComposer, 1_000);
  }
  if (!prepared) {
    throw capabilityUnavailableError(resolveCapability("composer", document, { required: true }).discovery,
      "WhatsApp localizó el composer, pero no conservó exactamente el texto preparado por la campaña.");
  }
  return "inserted";
}

export function scheduleConversationNavigation(phoneDigits: string): void {
  const target = new URL("/send", "https://web.whatsapp.com");
  target.searchParams.set("phone", phoneDigits);
  target.searchParams.set("type", "phone_number");
  target.searchParams.set("app_absent", "0");
  window.setTimeout(() => window.location.assign(target.toString()), 0);
}

function messageRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>("#main [data-testid='conversation-panel-messages']")
    ?? document.getElementById("main");
  if (!root) {
    throw new ExtensionError(ERROR_CODES.verificationFailed, "WhatsApp perdió el contenedor de la conversación antes del envío.", {
      recoverable: true, details: { sendAttempted: false }
    });
  }
  return root;
}

function isComposerConsumed(): boolean {
  const composer = findComposer()?.element;
  if (!composer) return true;
  return !composerTextRepresentations(composer).some((value) => canonicalMessageText(value).trim());
}

type ObserverOutcome = {
  kind: "strong" | "causal" | "unverified";
  snapshot?: OutgoingMessageSnapshot;
  sendClickAt: string;
  firstOutgoingMutationAt: string | null;
  confirmedAt: string | null;
  verificationTimeoutAt: string | null;
  elapsedMs: number;
  mutationCount: number;
  candidateCount: number;
  newOutgoingObserved: boolean;
  exactTextObserved: boolean;
};

function armOutgoingVerification(input: {
  root: HTMLElement;
  expectedText: string;
  expectedPhoneDigits: string;
  timeoutMs: number;
}): { baselineIds: string[]; markClicked: () => void; cancel: () => void; wait: Promise<ObserverOutcome> } {
  const expected = canonicalMessageText(input.expectedText);
  const baseline = outgoingMessages(input.root);
  const baselineNodes = new WeakSet<HTMLElement>(baseline.map((item) => item.element));
  const baselineIds = new Set(baseline.filter((item) => item.stableIdentity).map((item) => item.identity));
  const baselineExactCount = baseline.filter((item) => item.text === expected).length;
  let clicked = false;
  let sendClickAtMs = 0;
  let sendClickAt = "";
  let firstOutgoingMutationAt: string | null = null;
  let mutationCount = 0;
  let candidateCount = 0;
  let newOutgoingObserved = false;
  let exactTextObserved = false;
  let settled = false;
  let causalTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveWait!: (value: ObserverOutcome) => void;
  let rejectWait!: (error: unknown) => void;

  const wait = new Promise<ObserverOutcome>((resolve, reject) => { resolveWait = resolve; rejectWait = reject; });
  const budget = Math.min(POST_CLICK_VERIFICATION_BUDGET_MS, Math.max(20, input.timeoutMs));
  const cleanup = (): void => {
    observer.disconnect();
    if (timeoutTimer) globalThis.clearTimeout(timeoutTimer);
    if (causalTimer) globalThis.clearTimeout(causalTimer);
  };
  const metrics = (kind: ObserverOutcome["kind"], snapshot?: OutgoingMessageSnapshot): ObserverOutcome => {
    const now = Date.now();
    return {
      kind,
      ...(snapshot ? { snapshot } : {}),
      sendClickAt,
      firstOutgoingMutationAt,
      confirmedAt: kind === "unverified" ? null : new Date().toISOString(),
      verificationTimeoutAt: kind === "unverified" ? new Date().toISOString() : null,
      elapsedMs: Math.max(0, now - sendClickAtMs),
      mutationCount,
      candidateCount,
      newOutgoingObserved,
      exactTextObserved
    };
  };
  const finish = (value: ObserverOutcome): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveWait(value);
  };
  const failAfterClick = (error: unknown): void => {
    if (settled) return;
    settled = true;
    cleanup();
    const normalized = toExtensionError(error);
    rejectWait(new ExtensionError(normalized.code, normalized.message, {
      recoverable: normalized.recoverable,
      cause: error,
      details: { ...(normalized.details ?? {}), sendAttempted: true, verificationOutcome: "ambiguous_critical" }
    }));
  };
  const currentMatchingNew = (): OutgoingMessageSnapshot[] => outgoingMessages(input.root).filter((item) =>
    !baselineNodes.has(item.element) && item.text === expected);
  const tryCandidate = (snapshot: OutgoingMessageSnapshot): void => {
    if (!clicked || baselineNodes.has(snapshot.element)) return;
    newOutgoingObserved = true;
    if (!firstOutgoingMutationAt) firstOutgoingMutationAt = new Date().toISOString();
    try { requireConversationContext(input.expectedPhoneDigits); } catch (error) { failAfterClick(error); return; }
    if (snapshot.text !== expected) return;
    exactTextObserved = true;
    if (snapshot.stableIdentity && !baselineIds.has(snapshot.identity)) {
      finish(metrics("strong", snapshot));
      return;
    }
    const exactCount = outgoingMessages(input.root).filter((item) => item.text === expected).length;
    if (exactCount <= baselineExactCount || causalTimer) return;
    causalTimer = globalThis.setTimeout(() => {
      causalTimer = null;
      if (settled) return;
      try { requireConversationContext(input.expectedPhoneDigits); } catch (error) { failAfterClick(error); return; }
      const candidates = currentMatchingNew();
      const strong = candidates.find((item) => item.stableIdentity && !baselineIds.has(item.identity));
      finish(metrics(strong ? "strong" : "causal", strong ?? candidates[0] ?? snapshot));
    }, Math.min(STRONG_ID_GRACE_MS, Math.max(1, budget)));
  };
  const processNode = (node: Node): void => {
    if (!(node instanceof HTMLElement)) return;
    for (const snapshot of outgoingMessages(node)) {
      candidateCount += 1;
      tryCandidate(snapshot);
      if (settled) return;
    }
  };
  const observer = new MutationObserver((records) => {
    if (!clicked || settled) return;
    mutationCount += records.length;
    for (const record of records) {
      if (record.type === "attributes") processNode(record.target);
      for (const node of record.addedNodes) processNode(node);
      if (settled) return;
    }
  });
  observer.observe(input.root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-id", "id"] });
  return {
    baselineIds: [...baselineIds],
    markClicked: () => {
      observer.takeRecords();
      clicked = true;
      sendClickAtMs = Date.now();
      sendClickAt = new Date(sendClickAtMs).toISOString();
      timeoutTimer = globalThis.setTimeout(() => {
        if (settled) return;
        try { requireConversationContext(input.expectedPhoneDigits); } catch (error) { failAfterClick(error); return; }
        finish(metrics("unverified"));
      }, budget);
    },
    cancel: () => {
      if (settled) return;
      settled = true;
      cleanup();
    },
    wait
  };
}

function verificationFromObservation(observation: ObserverOutcome, expectedLength: number): TextVerification {
  const composerConsumed = isComposerConsumed();
  const common = {
    sent: true,
    observedAt: observation.confirmedAt ?? observation.verificationTimeoutAt ?? new Date().toISOString(),
    matchedTextLength: observation.exactTextObserved ? expectedLength : undefined,
    stableIdObserved: Boolean(observation.snapshot?.stableIdentity),
    newOutgoingObserved: observation.newOutgoingObserved,
    exactTextObserved: observation.exactTextObserved,
    composerConsumed,
    recipientStillVerified: true,
    sendAttempted: true,
    verificationElapsedMs: observation.elapsedMs,
    observerMutationCount: observation.mutationCount,
    candidateOutgoingCount: observation.candidateCount,
    sendClickAt: observation.sendClickAt,
    firstOutgoingMutationAt: observation.firstOutgoingMutationAt ?? undefined,
    verificationTimeoutAt: observation.verificationTimeoutAt ?? undefined
  } satisfies Partial<TextVerification>;
  if (observation.kind === "strong") {
    return {
      ...common,
      confirmed: true,
      outcome: "confirmed_strong",
      confidence: "strong",
      method: "new-outgoing-message-stable-dom",
      messageElementId: observation.snapshot?.identity,
      strongConfirmedAt: observation.confirmedAt ?? undefined
    };
  }
  if (observation.kind === "causal") {
    return {
      ...common,
      confirmed: true,
      outcome: "confirmed_causal",
      confidence: "causal",
      method: "new-outgoing-node-after-click",
      causalConfirmedAt: observation.confirmedAt ?? undefined
    };
  }
  return {
    ...common,
    confirmed: false,
    outcome: "sent_unverified",
    confidence: "unverified",
    method: "send-click-unverified"
  };
}

export async function sendAndVerifyText(input: {
  operationId: string;
  phoneDigits: string;
  message: string;
  timeoutMs?: number;
  checkpointRequired?: boolean;
}, lifecycle: { beforeSend?: (baselineOutgoingIds: string[]) => Promise<void> } = {}): Promise<TextTestResult> {
  const { operationId, phoneDigits, message, timeoutMs = 30_000 } = input;
  const startedAt = new Date().toISOString();
  requireConversationContext(phoneDigits);
  const invalidDialog = findInvalidContactDialog();
  if (invalidDialog) throw new ExtensionError(ERROR_CODES.contactUnavailable, "WhatsApp informó que el número no es válido o no está disponible.", { details: { selectorStrategy: invalidDialog.strategy } });

  const composerMatch = await waitForCondition(() => {
    const invalid = findInvalidContactDialog();
    if (invalid) throw new ExtensionError(ERROR_CODES.contactUnavailable, "El número no está disponible en WhatsApp.");
    return findComposer();
  }, { timeoutMs, description: "el campo de escritura de la conversación" }).catch((error: unknown) => {
    const normalized = toExtensionError(error);
    if (normalized.code === ERROR_CODES.contactUnavailable) throw normalized;
    throw capabilityResolutionError(resolveCapability("composer", document, { required: true }).discovery,
      "La capability del composer dejó de estar disponible.", error);
  });

  await prepareComposerTextForSend(composerMatch.element, message);
  const sendButton = await waitForCondition(() => findSendButton(), {
    timeoutMs: Math.min(timeoutMs, 10_000), description: "la acción de enviar texto"
  }).catch((error: unknown) => {
    throw capabilityResolutionError(resolveCapability("text_send_action", document, { required: true }).discovery,
      "Se agotaron las estrategias para localizar la acción de envío de texto.", error);
  });
  if (sendButton.element.disabled || sendButton.element.getAttribute("aria-disabled") === "true") {
    throw capabilityUnavailableError(resolveCapability("text_send_action", document, { required: true }).discovery,
      "La acción de envío de texto fue localizada, pero no está disponible.");
  }

  const verification = armOutgoingVerification({ root: messageRoot(), expectedText: message, expectedPhoneDigits: phoneDigits, timeoutMs });
  try {
    await lifecycle.beforeSend?.(verification.baselineIds);
    requireConversationContext(phoneDigits);
    const liveComposer = findComposer()?.element;
    if (!liveComposer || classifyComposerElementContent(liveComposer, message) !== "prepared") {
      throw new ExtensionError(ERROR_CODES.verificationFailed,
        "El contenido del composer cambió antes del envío. Se canceló el click para evitar enviar texto incorrecto.",
        { recoverable: true, details: { sendAttempted: false, expectedLength: message.length } });
    }
    verification.markClicked();
    sendButton.element.click();
  } catch (error) {
    verification.cancel();
    throw error;
  }

  const observation = await verification.wait;
  requireConversationContext(phoneDigits);
  const verified = verificationFromObservation(observation, canonicalMessageText(message).length);
  const completedAt = new Date().toISOString();
  return {
    success: true,
    operationId,
    contactId: await contactIdForPhone(phoneDigits),
    maskedPhone: maskPhone(`+${phoneDigits}`),
    step: "text",
    startedAt,
    completedAt,
    verification: verified
  };
}
