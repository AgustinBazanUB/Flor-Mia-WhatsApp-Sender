import { ERROR_CODES, ExtensionError } from "../shared/errors";

export interface ConversationContextProof {
  verified: true;
  evidence: "structured-recipient-id";
  checkedAt: string;
}

const RECIPIENT_ATTRIBUTES = ["data-id", "data-jid", "data-chat-id", "data-peer-id", "data-contact-id"] as const;
const STRUCTURED_SELECTOR = RECIPIENT_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(",");

function recipientIdsFrom(value: string): string[] {
  const ids = new Set<string>();
  const trimmed = value.trim();
  if (/^\d{8,15}$/.test(trimmed)) ids.add(trimmed);
  for (const match of trimmed.matchAll(/(?:^|[^\d])(\d{8,15})@(?:c\.us|s\.whatsapp\.net)(?=$|[^a-z])/gi)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

export function proveConversationContext(
  expectedPhoneDigits: string,
  root: ParentNode = document
): ConversationContextProof | null {
  if (!/^\d{8,15}$/.test(expectedPhoneDigits)) return null;
  const main = root.querySelector<HTMLElement>("#main");
  if (!main) return null;
  const candidates = [main, ...main.querySelectorAll<HTMLElement>(STRUCTURED_SELECTOR)];
  const observed = new Set<string>();
  for (const candidate of candidates) {
    for (const attribute of RECIPIENT_ATTRIBUTES) {
      const value = candidate.getAttribute(attribute);
      if (!value) continue;
      for (const recipientId of recipientIdsFrom(value)) observed.add(recipientId);
    }
  }
  if (observed.size !== 1 || !observed.has(expectedPhoneDigits)) return null;
  return { verified: true, evidence: "structured-recipient-id", checkedAt: new Date().toISOString() };
}

export function requireConversationContext(expectedPhoneDigits: string, root: ParentNode = document): ConversationContextProof {
  const proof = proveConversationContext(expectedPhoneDigits, root);
  if (proof) return proof;
  throw new ExtensionError(
    ERROR_CODES.contactContextUnverified,
    "No se pudo demostrar que el chat activo corresponda al destinatario esperado. No se enviará contenido.",
    { recoverable: true }
  );
}
