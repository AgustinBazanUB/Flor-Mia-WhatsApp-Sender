import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { maskPhone } from "../shared/phone";
import { conversationGuardSnapshot } from "./conversation-guard";
import { findComposer, findInvalidContactDialog } from "./selectors";
import { waitForCondition } from "./wait";

export type ConversationProofLevel = "strong" | "causal";
export type ConversationProofStrategy =
  | "url-recipient-phone"
  | "header-recipient-id"
  | "main-recipient-id"
  | "message-jid-consensus"
  | "causal-navigation";

export interface ConversationContextProof {
  verified: true;
  proofLevel: ConversationProofLevel;
  evidence: ConversationProofStrategy;
  checkedAt: string;
  expectedMaskedPhone: string;
  expectedCanonicalLength: number;
  observedIdentifierType: "jid" | "digits" | "causal";
  observedMaskedIdentifier: string | null;
  normalizationApplied: "none" | "argentina-mobile-9-equivalent";
  navigationRequestId?: string;
}

export interface CausalNavigationContext {
  navigationRequestId: string;
  contentInstanceId: string;
  requestedNavigationAt: string;
  navigationObservedAt: string;
}

export interface ConversationProofObservation {
  proofAttempt: number;
  proofLevel: ConversationProofLevel | "failed";
  proofStrategy: ConversationProofStrategy | "none";
  expectedMaskedPhone: string;
  expectedCanonicalLength: number;
  observedIdentifierType: "jid" | "digits" | "causal" | "none";
  observedMaskedIdentifier: string | null;
  normalizationApplied: "none" | "argentina-mobile-9-equivalent";
  proofResult: "verified" | "waiting";
  proofFailureReason:
    | "missing_main"
    | "missing_composer"
    | "insufficient_evidence"
    | "recipient_mismatch"
    | "conflicting_identifiers"
    | "invalid_phone"
    | "manual_navigation_detected"
    | "stale_navigation"
    | null;
  elapsedMs: number;
}

interface ObservedIdentifier {
  digits: string;
  type: "jid" | "digits";
}

interface ProofInspection {
  proof: ConversationContextProof | null;
  strategy: ConversationProofStrategy | "none";
  observed: ObservedIdentifier[];
  normalizationApplied: "none" | "argentina-mobile-9-equivalent";
  failureReason: ConversationProofObservation["proofFailureReason"];
}

interface ActiveConversationLease {
  expectedPhoneDigits: string;
  navigationRequestId: string;
  contentInstanceId: string;
  guardEpoch: number;
  conversationFingerprint: string;
  mainElement: Element;
  establishedAtMs: number;
}

const RECIPIENT_ATTRIBUTES = ["data-jid", "data-chat-id", "data-peer-id", "data-contact-id"] as const;
const HEADER_RECIPIENT_SELECTOR = RECIPIENT_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(",");
const MESSAGE_JID_SELECTOR = "[data-id*='@c.us'],[data-id*='@s.whatsapp.net'],[data-jid*='@c.us'],[data-jid*='@s.whatsapp.net']";
const CAUSAL_LEASE_MAX_AGE_MS = 2 * 60_000;
const PROOF_WAIT_DEFAULT_MS = 4_000;
let activeLease: ActiveConversationLease | null = null;

function recipientIdsFrom(value: string): ObservedIdentifier[] {
  const ids = new Map<string, ObservedIdentifier>();
  const trimmed = value.trim();
  if (/^\d{8,15}$/.test(trimmed)) ids.set(trimmed, { digits: trimmed, type: "digits" });
  for (const match of trimmed.matchAll(/(?:^|[^\d])(\d{8,15})@(?:c\.us|s\.whatsapp\.net)(?=$|[^a-z])/gi)) {
    if (match[1]) ids.set(match[1], { digits: match[1], type: "jid" });
  }
  return [...ids.values()];
}

function comparableExpectedIds(expectedPhoneDigits: string): Set<string> {
  const ids = new Set([expectedPhoneDigits]);
  const argentinaMobile = expectedPhoneDigits.match(/^549(\d{10})$/);
  if (argentinaMobile?.[1]) ids.add(`54${argentinaMobile[1]}`);
  return ids;
}

function normalizationFor(expectedPhoneDigits: string, observedDigits: string): "none" | "argentina-mobile-9-equivalent" {
  return expectedPhoneDigits === observedDigits ? "none" : "argentina-mobile-9-equivalent";
}

function identifiersFromCandidates(candidates: Element[], attributes: readonly string[]): ObservedIdentifier[] {
  const ids = new Map<string, ObservedIdentifier>();
  for (const candidate of candidates) {
    for (const attribute of attributes) {
      const value = candidate.getAttribute(attribute);
      if (!value) continue;
      for (const identifier of recipientIdsFrom(value)) ids.set(`${identifier.type}:${identifier.digits}`, identifier);
    }
  }
  return [...ids.values()];
}

function inspectIdentifiers(
  expectedPhoneDigits: string,
  identifiers: ObservedIdentifier[],
  strategy: ConversationProofStrategy
): ProofInspection {
  if (!identifiers.length) {
    return { proof: null, strategy, observed: [], normalizationApplied: "none", failureReason: "insufficient_evidence" };
  }
  const expectedIds = comparableExpectedIds(expectedPhoneDigits);
  const matching = identifiers.filter((identifier) => expectedIds.has(identifier.digits));
  const conflicting = identifiers.filter((identifier) => !expectedIds.has(identifier.digits));
  if (!matching.length) {
    return { proof: null, strategy, observed: identifiers, normalizationApplied: "none", failureReason: "recipient_mismatch" };
  }
  if (conflicting.length) {
    return { proof: null, strategy, observed: identifiers, normalizationApplied: "none", failureReason: "conflicting_identifiers" };
  }
  const selected = matching[0]!;
  const normalizationApplied = normalizationFor(expectedPhoneDigits, selected.digits);
  return {
    proof: {
      verified: true,
      proofLevel: "strong",
      evidence: strategy,
      checkedAt: new Date().toISOString(),
      expectedMaskedPhone: maskPhone(`+${expectedPhoneDigits}`),
      expectedCanonicalLength: expectedPhoneDigits.length,
      observedIdentifierType: selected.type,
      observedMaskedIdentifier: maskPhone(`+${selected.digits}`),
      normalizationApplied
    },
    strategy,
    observed: identifiers,
    normalizationApplied,
    failureReason: null
  };
}

function inspectStructuredIdentifiers(expectedPhoneDigits: string, root: ParentNode): ProofInspection {
  const main = root.querySelector<HTMLElement>("#main");
  if (!main) return { proof: null, strategy: "none", observed: [], normalizationApplied: "none", failureReason: "missing_main" };

  const header = main.querySelector("header");
  if (header) {
    const headerCandidates = [header, ...[...header.querySelectorAll(HEADER_RECIPIENT_SELECTOR)].slice(0, 40)];
    const headerIds = identifiersFromCandidates(headerCandidates, [...RECIPIENT_ATTRIBUTES, "data-id"]);
    if (headerIds.length) return inspectIdentifiers(expectedPhoneDigits, headerIds, "header-recipient-id");
  }

  const mainIds = identifiersFromCandidates([main], [...RECIPIENT_ATTRIBUTES, "data-id"]);
  if (mainIds.length) return inspectIdentifiers(expectedPhoneDigits, mainIds, "main-recipient-id");

  const messageCandidates = [...main.querySelectorAll(MESSAGE_JID_SELECTOR)].slice(-60);
  const messageIds = identifiersFromCandidates(messageCandidates, ["data-id", "data-jid"]);
  if (messageIds.length) return inspectIdentifiers(expectedPhoneDigits, messageIds, "message-jid-consensus");

  return { proof: null, strategy: "none", observed: [], normalizationApplied: "none", failureReason: "insufficient_evidence" };
}

function currentUrlPhone(): ObservedIdentifier | null {
  try {
    const url = new URL(window.location.href);
    const phone = (url.searchParams.get("phone") ?? "").replace(/\D/g, "");
    return /^\d{8,15}$/.test(phone) ? { digits: phone, type: "digits" } : null;
  } catch {
    return null;
  }
}

function safeFingerprintPart(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function conversationFingerprint(main: Element): string {
  const header = main.querySelector("header");
  const parts = [
    safeFingerprintPart(header?.textContent),
    safeFingerprintPart(header?.getAttribute("title")),
    ...RECIPIENT_ATTRIBUTES.map((attribute) => safeFingerprintPart(header?.getAttribute(attribute))),
    safeFingerprintPart(main.getAttribute("data-testid")),
    safeFingerprintPart(main.getAttribute("role"))
  ];
  return fnv1a(parts.join("|"));
}

function validNavigationChronology(context: CausalNavigationContext): boolean {
  if (!context.navigationRequestId || !context.contentInstanceId) return false;
  const requested = Date.parse(context.requestedNavigationAt);
  const observed = Date.parse(context.navigationObservedAt);
  if (!Number.isFinite(requested) || !Number.isFinite(observed)) return false;
  return observed >= requested && observed - requested <= 60_000;
}

function inspectUrlProof(expectedPhoneDigits: string): ProofInspection | null {
  const observed = currentUrlPhone();
  if (!observed) return null;
  return inspectIdentifiers(expectedPhoneDigits, [observed], "url-recipient-phone");
}

function causalProof(
  expectedPhoneDigits: string,
  root: ParentNode,
  context: CausalNavigationContext
): ProofInspection {
  if (!validNavigationChronology(context)) {
    return { proof: null, strategy: "causal-navigation", observed: [], normalizationApplied: "none", failureReason: "stale_navigation" };
  }
  if (findInvalidContactDialog(root)) {
    return { proof: null, strategy: "causal-navigation", observed: [], normalizationApplied: "none", failureReason: "invalid_phone" };
  }
  const main = root.querySelector<HTMLElement>("#main");
  if (!main) return { proof: null, strategy: "causal-navigation", observed: [], normalizationApplied: "none", failureReason: "missing_main" };
  if (!main.querySelector("header") || !findComposer(root)) {
    return { proof: null, strategy: "causal-navigation", observed: [], normalizationApplied: "none", failureReason: "missing_composer" };
  }
  const guard = conversationGuardSnapshot();
  if (guard.trustedNavigationEpoch !== 0) {
    return { proof: null, strategy: "causal-navigation", observed: [], normalizationApplied: "none", failureReason: "manual_navigation_detected" };
  }

  const lease: ActiveConversationLease = {
    expectedPhoneDigits,
    navigationRequestId: context.navigationRequestId,
    contentInstanceId: context.contentInstanceId,
    guardEpoch: guard.trustedNavigationEpoch,
    conversationFingerprint: conversationFingerprint(main),
    mainElement: main,
    establishedAtMs: Date.now()
  };
  activeLease = lease;
  return {
    proof: {
      verified: true,
      proofLevel: "causal",
      evidence: "causal-navigation",
      checkedAt: new Date().toISOString(),
      expectedMaskedPhone: maskPhone(`+${expectedPhoneDigits}`),
      expectedCanonicalLength: expectedPhoneDigits.length,
      observedIdentifierType: "causal",
      observedMaskedIdentifier: null,
      normalizationApplied: "none",
      navigationRequestId: context.navigationRequestId
    },
    strategy: "causal-navigation",
    observed: [],
    normalizationApplied: "none",
    failureReason: null
  };
}

function establishLeaseFromStrongProof(
  expectedPhoneDigits: string,
  root: ParentNode,
  context: CausalNavigationContext
): void {
  const main = root.querySelector<HTMLElement>("#main");
  if (!main || !validNavigationChronology(context)) return;
  const guard = conversationGuardSnapshot();
  activeLease = {
    expectedPhoneDigits,
    navigationRequestId: context.navigationRequestId,
    contentInstanceId: context.contentInstanceId,
    guardEpoch: guard.trustedNavigationEpoch,
    conversationFingerprint: conversationFingerprint(main),
    mainElement: main,
    establishedAtMs: Date.now()
  };
}

function inspectInitialProof(
  expectedPhoneDigits: string,
  root: ParentNode,
  context?: CausalNavigationContext
): ProofInspection {
  if (!/^\d{8,15}$/.test(expectedPhoneDigits)) {
    return { proof: null, strategy: "none", observed: [], normalizationApplied: "none", failureReason: "insufficient_evidence" };
  }
  if (findInvalidContactDialog(root)) {
    return { proof: null, strategy: "none", observed: [], normalizationApplied: "none", failureReason: "invalid_phone" };
  }

  const urlInspection = inspectUrlProof(expectedPhoneDigits);
  if (urlInspection) {
    if (urlInspection.proof && context && validNavigationChronology(context)) establishLeaseFromStrongProof(expectedPhoneDigits, root, context);
    return urlInspection;
  }

  const structured = inspectStructuredIdentifiers(expectedPhoneDigits, root);
  if (structured.proof) {
    if (context && validNavigationChronology(context)) establishLeaseFromStrongProof(expectedPhoneDigits, root, context);
    return structured;
  }
  if (["recipient_mismatch", "conflicting_identifiers"].includes(structured.failureReason ?? "")) return structured;
  if (!context) return structured;
  return causalProof(expectedPhoneDigits, root, context);
}

function validateActiveLease(expectedPhoneDigits: string, root: ParentNode): ConversationContextProof | null {
  const lease = activeLease;
  if (!lease || lease.expectedPhoneDigits !== expectedPhoneDigits) return null;
  if (Date.now() - lease.establishedAtMs > CAUSAL_LEASE_MAX_AGE_MS) return null;
  if (conversationGuardSnapshot().trustedNavigationEpoch !== lease.guardEpoch) return null;
  if (findInvalidContactDialog(root)) return null;
  const main = root.querySelector<HTMLElement>("#main");
  if (!main || main !== lease.mainElement || !findComposer(root)) return null;

  const urlInspection = inspectUrlProof(expectedPhoneDigits);
  if (urlInspection && !urlInspection.proof) return null;
  const structured = inspectStructuredIdentifiers(expectedPhoneDigits, root);
  if (["recipient_mismatch", "conflicting_identifiers"].includes(structured.failureReason ?? "")) return null;
  if (conversationFingerprint(main) !== lease.conversationFingerprint) return null;

  return {
    verified: true,
    proofLevel: structured.proof ? "strong" : "causal",
    evidence: structured.proof?.evidence ?? urlInspection?.proof?.evidence ?? "causal-navigation",
    checkedAt: new Date().toISOString(),
    expectedMaskedPhone: maskPhone(`+${expectedPhoneDigits}`),
    expectedCanonicalLength: expectedPhoneDigits.length,
    observedIdentifierType: structured.proof?.observedIdentifierType ?? urlInspection?.proof?.observedIdentifierType ?? "causal",
    observedMaskedIdentifier: structured.proof?.observedMaskedIdentifier ?? urlInspection?.proof?.observedMaskedIdentifier ?? null,
    normalizationApplied: structured.proof?.normalizationApplied ?? urlInspection?.proof?.normalizationApplied ?? "none",
    navigationRequestId: lease.navigationRequestId
  };
}

export function inspectConversationContext(
  expectedPhoneDigits: string,
  root: ParentNode = document,
  context?: CausalNavigationContext
): ProofInspection {
  return inspectInitialProof(expectedPhoneDigits, root, context);
}

export function proveConversationContext(
  expectedPhoneDigits: string,
  root: ParentNode = document,
  context?: CausalNavigationContext
): ConversationContextProof | null {
  return inspectInitialProof(expectedPhoneDigits, root, context).proof ?? validateActiveLease(expectedPhoneDigits, root);
}

export async function waitForConversationContext(
  expectedPhoneDigits: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    root?: ParentNode;
    causalNavigation?: CausalNavigationContext;
    onObservation?: (observation: ConversationProofObservation) => void;
  } = {}
): Promise<ConversationContextProof> {
  if (!/^\d{8,15}$/.test(expectedPhoneDigits)) {
    throw new ExtensionError(ERROR_CODES.contactContextUnverified, "No se pudo confirmar el contacto correcto.", { recoverable: true });
  }
  const started = Date.now();
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? PROOF_WAIT_DEFAULT_MS, PROOF_WAIT_DEFAULT_MS));
  const root = options.root ?? document;
  let proofAttempt = 0;
  let lastInspection = inspectInitialProof(expectedPhoneDigits, root, options.causalNavigation);
  let lastObservationKey = "";

  const inspect = (): ConversationContextProof | null => {
    proofAttempt += 1;
    lastInspection = inspectInitialProof(expectedPhoneDigits, root, options.causalNavigation);
    const observed = lastInspection.observed[0] ?? null;
    const observation: ConversationProofObservation = {
      proofAttempt,
      proofLevel: lastInspection.proof?.proofLevel ?? "failed",
      proofStrategy: lastInspection.strategy,
      expectedMaskedPhone: maskPhone(`+${expectedPhoneDigits}`),
      expectedCanonicalLength: expectedPhoneDigits.length,
      observedIdentifierType: lastInspection.proof?.observedIdentifierType ?? observed?.type ?? "none",
      observedMaskedIdentifier: lastInspection.proof?.observedMaskedIdentifier ?? (observed ? maskPhone(`+${observed.digits}`) : null),
      normalizationApplied: lastInspection.normalizationApplied,
      proofResult: lastInspection.proof ? "verified" : "waiting",
      proofFailureReason: lastInspection.failureReason,
      elapsedMs: Date.now() - started
    };
    const observationKey = JSON.stringify([
      observation.proofLevel,
      observation.proofStrategy,
      observation.observedIdentifierType,
      observation.observedMaskedIdentifier,
      observation.normalizationApplied,
      observation.proofResult,
      observation.proofFailureReason
    ]);
    if (observationKey !== lastObservationKey || lastInspection.proof) {
      lastObservationKey = observationKey;
      options.onObservation?.(observation);
    }
    return lastInspection.proof;
  };

  const initial = inspect();
  if (initial) return initial;
  if (["recipient_mismatch", "conflicting_identifiers", "invalid_phone", "manual_navigation_detected", "stale_navigation"].includes(lastInspection.failureReason ?? "")) {
    throw proofFailure(expectedPhoneDigits, lastInspection, proofAttempt, Date.now() - started);
  }

  const main = root.querySelector?.("#main") ?? null;
  const observationRoot = main ?? document.documentElement;
  try {
    return await waitForCondition(() => {
      const proof = inspect();
      if (!proof && ["recipient_mismatch", "conflicting_identifiers", "invalid_phone", "manual_navigation_detected", "stale_navigation"].includes(lastInspection.failureReason ?? "")) {
        throw proofFailure(expectedPhoneDigits, lastInspection, proofAttempt, Date.now() - started);
      }
      return proof;
    }, {
      timeoutMs,
      signal: options.signal,
      root: observationRoot,
      description: "evidencia segura del destinatario activo",
      observe: {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-id", "data-jid", "data-chat-id", "data-peer-id", "data-contact-id", "title"]
      }
    });
  } catch (error) {
    if (error instanceof ExtensionError && error.code === ERROR_CODES.contactContextUnverified) throw error;
    throw proofFailure(expectedPhoneDigits, lastInspection, proofAttempt, Date.now() - started, error);
  }
}

function proofFailure(
  expectedPhoneDigits: string,
  inspection: ProofInspection,
  proofAttempt: number,
  elapsedMs: number,
  cause?: unknown
): ExtensionError {
  const observed = inspection.observed[0] ?? null;
  const retryWithoutNewEvidence = ![
    "insufficient_evidence",
    "recipient_mismatch",
    "conflicting_identifiers",
    "invalid_phone",
    "manual_navigation_detected",
    "stale_navigation"
  ].includes(inspection.failureReason ?? "");
  return new ExtensionError(
    ERROR_CODES.contactContextUnverified,
    "No pudimos confirmar que WhatsApp abrió el contacto correcto. La campaña se pausó para evitar un envío incorrecto.",
    {
      recoverable: true,
      cause,
      details: {
        proofAttempt,
        proofLevel: "failed",
        proofStrategy: inspection.strategy,
        expectedMaskedPhone: maskPhone(`+${expectedPhoneDigits}`),
        expectedCanonicalLength: expectedPhoneDigits.length,
        observedIdentifierType: observed?.type ?? "none",
        observedMaskedIdentifier: observed ? maskPhone(`+${observed.digits}`) : null,
        normalizationApplied: inspection.normalizationApplied,
        proofResult: "failed",
        proofFailureReason: inspection.failureReason,
        retryWithoutNewEvidence,
        elapsedMs
      }
    }
  );
}

export function requireConversationContext(expectedPhoneDigits: string, root: ParentNode = document): ConversationContextProof {
  const proof = proveConversationContext(expectedPhoneDigits, root);
  if (proof) return proof;
  const inspection = inspectInitialProof(expectedPhoneDigits, root);
  const observed = inspection.observed[0] ?? null;
  throw new ExtensionError(
    ERROR_CODES.contactContextUnverified,
    "No pudimos confirmar que WhatsApp abrió el contacto correcto. La campaña se pausó para evitar un envío incorrecto.",
    {
      recoverable: true,
      details: {
        proofLevel: "failed",
        proofStrategy: inspection.strategy,
        expectedMaskedPhone: maskPhone(`+${expectedPhoneDigits}`),
        expectedCanonicalLength: expectedPhoneDigits.length,
        observedIdentifierType: observed?.type ?? "none",
        observedMaskedIdentifier: observed ? maskPhone(`+${observed.digits}`) : null,
        normalizationApplied: inspection.normalizationApplied,
        proofFailureReason: inspection.failureReason,
        retryWithoutNewEvidence: false
      }
    }
  );
}
