import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { maskPhone } from "../shared/phone";
import { waitForCondition } from "./wait";

export type ConversationProofStrategy = "header-recipient-id" | "main-recipient-id" | "message-jid-consensus";

export interface ConversationContextProof {
  verified: true;
  evidence: ConversationProofStrategy;
  checkedAt: string;
  expectedMaskedPhone: string;
  expectedCanonicalLength: number;
  observedIdentifierType: "jid" | "digits";
  observedMaskedIdentifier: string;
  normalizationApplied: "none" | "argentina-mobile-9-equivalent";
}

export interface ConversationProofObservation {
  proofAttempt: number;
  proofStrategy: ConversationProofStrategy | "none";
  expectedMaskedPhone: string;
  expectedCanonicalLength: number;
  observedIdentifierType: "jid" | "digits" | "none";
  observedMaskedIdentifier: string | null;
  normalizationApplied: "none" | "argentina-mobile-9-equivalent";
  proofResult: "verified" | "waiting";
  proofFailureReason: "missing_main" | "insufficient_evidence" | "recipient_mismatch" | "conflicting_identifiers" | null;
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

const RECIPIENT_ATTRIBUTES = ["data-jid", "data-chat-id", "data-peer-id", "data-contact-id"] as const;
const HEADER_RECIPIENT_SELECTOR = RECIPIENT_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(",");
const MESSAGE_JID_SELECTOR = "[data-id*='@c.us'],[data-id*='@s.whatsapp.net'],[data-jid*='@c.us'],[data-jid*='@s.whatsapp.net']";

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
  // El contrato canónico de Flor Mía usa 549 + número nacional para móviles argentinos.
  // WhatsApp puede exponer el mismo peer como 54 + número nacional en ciertos JID internos.
  // Sólo aceptamos esa equivalencia cuando el payload ya declaró inequívocamente 549.
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

export function inspectConversationContext(expectedPhoneDigits: string, root: ParentNode = document): ProofInspection {
  if (!/^\d{8,15}$/.test(expectedPhoneDigits)) {
    return { proof: null, strategy: "none", observed: [], normalizationApplied: "none", failureReason: "insufficient_evidence" };
  }
  const main = root.querySelector<HTMLElement>("#main");
  if (!main) return { proof: null, strategy: "none", observed: [], normalizationApplied: "none", failureReason: "missing_main" };

  // Primero usamos metadata estructurada del header. Evitamos recorrer todos los data-id
  // del chat: muchos corresponden a mensajes y no al destinatario activo.
  const header = main.querySelector("header");
  if (header) {
    const headerCandidates = [header, ...[...header.querySelectorAll(HEADER_RECIPIENT_SELECTOR)].slice(0, 40)];
    const headerIds = identifiersFromCandidates(headerCandidates, [...RECIPIENT_ATTRIBUTES, "data-id"]);
    if (headerIds.length) return inspectIdentifiers(expectedPhoneDigits, headerIds, "header-recipient-id");
  }

  const mainIds = identifiersFromCandidates([main], [...RECIPIENT_ATTRIBUTES, "data-id"]);
  if (mainIds.length) return inspectIdentifiers(expectedPhoneDigits, mainIds, "main-recipient-id");

  // Contactos guardados suelen mostrar un nombre en el header. Como fallback fuerte usamos
  // JID estructurados de mensajes, pero sólo si todos los identificadores observados coinciden
  // con el mismo peer esperado. Texto visible, composer y URL por sí solos nunca prueban identidad.
  const messageCandidates = [...main.querySelectorAll(MESSAGE_JID_SELECTOR)].slice(-60);
  const messageIds = identifiersFromCandidates(messageCandidates, ["data-id", "data-jid"]);
  if (messageIds.length) return inspectIdentifiers(expectedPhoneDigits, messageIds, "message-jid-consensus");

  return { proof: null, strategy: "none", observed: [], normalizationApplied: "none", failureReason: "insufficient_evidence" };
}

export function proveConversationContext(
  expectedPhoneDigits: string,
  root: ParentNode = document
): ConversationContextProof | null {
  return inspectConversationContext(expectedPhoneDigits, root).proof;
}

export async function waitForConversationContext(
  expectedPhoneDigits: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    root?: ParentNode;
    onObservation?: (observation: ConversationProofObservation) => void;
  } = {}
): Promise<ConversationContextProof> {
  if (!/^\d{8,15}$/.test(expectedPhoneDigits)) {
    throw new ExtensionError(ERROR_CODES.contactContextUnverified, "No se pudo confirmar el contacto correcto.", { recoverable: true });
  }
  const started = Date.now();
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 15_000, 30_000));
  const root = options.root ?? document;
  let proofAttempt = 0;
  let lastInspection = inspectConversationContext(expectedPhoneDigits, root);
  let lastObservationKey = "";

  const inspect = (): ConversationContextProof | null => {
    proofAttempt += 1;
    lastInspection = inspectConversationContext(expectedPhoneDigits, root);
    const observed = lastInspection.observed[0] ?? null;
    const observation: ConversationProofObservation = {
      proofAttempt,
      proofStrategy: lastInspection.strategy,
      expectedMaskedPhone: maskPhone(`+${expectedPhoneDigits}`),
      expectedCanonicalLength: expectedPhoneDigits.length,
      observedIdentifierType: observed?.type ?? "none",
      observedMaskedIdentifier: observed ? maskPhone(`+${observed.digits}`) : null,
      normalizationApplied: lastInspection.normalizationApplied,
      proofResult: lastInspection.proof ? "verified" : "waiting",
      proofFailureReason: lastInspection.failureReason,
      elapsedMs: Date.now() - started
    };
    const observationKey = JSON.stringify([
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

  const main = root.querySelector?.("#main") ?? null;
  const observationRoot = main ?? document.documentElement;
  try {
    return await waitForCondition(inspect, {
      timeoutMs,
      signal: options.signal,
      root: observationRoot,
      description: "evidencia estructurada del destinatario activo",
      observe: {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-id", "data-jid", "data-chat-id", "data-peer-id", "data-contact-id"]
      }
    });
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const observed = lastInspection.observed[0] ?? null;
    throw new ExtensionError(
      ERROR_CODES.contactContextUnverified,
      "No pudimos confirmar que WhatsApp abrió el contacto correcto. La campaña se pausó para evitar un envío incorrecto.",
      {
        recoverable: true,
        cause: error,
        details: {
          proofAttempt,
          proofStrategy: lastInspection.strategy,
          expectedMaskedPhone: maskPhone(`+${expectedPhoneDigits}`),
          expectedCanonicalLength: expectedPhoneDigits.length,
          observedIdentifierType: observed?.type ?? "none",
          observedMaskedIdentifier: observed ? maskPhone(`+${observed.digits}`) : null,
          normalizationApplied: lastInspection.normalizationApplied,
          proofResult: "failed",
          proofFailureReason: lastInspection.failureReason,
          elapsedMs
        }
      }
    );
  }
}

export function requireConversationContext(expectedPhoneDigits: string, root: ParentNode = document): ConversationContextProof {
  const proof = proveConversationContext(expectedPhoneDigits, root);
  if (proof) return proof;
  const inspection = inspectConversationContext(expectedPhoneDigits, root);
  const observed = inspection.observed[0] ?? null;
  throw new ExtensionError(
    ERROR_CODES.contactContextUnverified,
    "No pudimos confirmar que WhatsApp abrió el contacto correcto. La campaña se pausó para evitar un envío incorrecto.",
    {
      recoverable: true,
      details: {
        proofStrategy: inspection.strategy,
        expectedMaskedPhone: maskPhone(`+${expectedPhoneDigits}`),
        expectedCanonicalLength: expectedPhoneDigits.length,
        observedIdentifierType: observed?.type ?? "none",
        observedMaskedIdentifier: observed ? maskPhone(`+${observed.digits}`) : null,
        normalizationApplied: inspection.normalizationApplied,
        proofFailureReason: inspection.failureReason
      }
    }
  );
}
