import type { ContactPhoneSource } from "./types";

export interface NormalizedExportPhone {
  e164: string;
  digits: string;
}

const E164_DIGITS = /^[1-9]\d{7,14}$/;

function cleanedDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Normaliza sólo cuando la fuente aporta código internacional de forma inequívoca.
 * No agrega país, característica ni el 9 móvil argentino por inferencia.
 */
export function normalizeVisibleInternationalPhone(value: string | null | undefined): NormalizedExportPhone | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const declaresInternational = raw.startsWith("+") || raw.startsWith("00");
  if (!declaresInternational) return null;
  const digits = cleanedDigits(raw.startsWith("00") ? raw.slice(2) : raw);
  if (!E164_DIGITS.test(digits)) return null;
  return { e164: `+${digits}`, digits };
}

/**
 * Los JID personales de WhatsApp contienen una identidad numérica global.
 * Conservamos exactamente esos dígitos y sólo añadimos el prefijo visual +.
 */
export function normalizeWhatsAppJidPhone(value: string | null | undefined): NormalizedExportPhone | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/(?:^|[^\d])(\d{8,15})@(?:c\.us|s\.whatsapp\.net)(?:$|[^a-z])/i);
  if (!match?.[1] || !E164_DIGITS.test(match[1])) return null;
  return { e164: `+${match[1]}`, digits: match[1] };
}

/**
 * Sólo para atributos que declaran semánticamente que su valor ES un teléfono
 * internacional (por ejemplo data-phone o ?phone= de WhatsApp). Un número suelto
 * en texto visible no entra por esta ruta.
 */
export function normalizeStructuredPhone(value: string | null | undefined): NormalizedExportPhone | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = cleanedDigits(raw.startsWith("00") ? raw.slice(2) : raw);
  if (!E164_DIGITS.test(digits)) return null;
  return { e164: `+${digits}`, digits };
}

export function normalizeExportPhoneCandidate(
  value: string | null | undefined,
  source: Exclude<ContactPhoneSource, "none">
): NormalizedExportPhone | null {
  if (source === "jid") return normalizeWhatsAppJidPhone(value);
  if (source === "structured_phone" || source === "href_phone") return normalizeStructuredPhone(value);
  return normalizeVisibleInternationalPhone(value);
}

export function canonicalExportPhoneKey(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  const normalized = normalizeVisibleInternationalPhone(raw);
  return normalized?.digits ?? "";
}
