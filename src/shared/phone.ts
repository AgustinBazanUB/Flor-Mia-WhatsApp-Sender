import { ERROR_CODES, ExtensionError } from "./errors";

export interface NormalizedPhone {
  e164: string;
  digits: string;
  masked: string;
}

export function normalizePhone(value: string, options: { allowDigitsOnly?: boolean } = {}): NormalizedPhone {
  const raw = String(value ?? "").trim();
  if (!raw) throw new ExtensionError(ERROR_CODES.invalidInput, "Ingresá un número de teléfono.");
  if (!raw.startsWith("+") && !options.allowDigitsOnly) {
    throw new ExtensionError(
      ERROR_CODES.invalidInput,
      "Ingresá el número en formato internacional, comenzando con + y el código de país."
    );
  }
  if (!raw.startsWith("+") && !/^\d+$/.test(raw)) {
    throw new ExtensionError(ERROR_CODES.invalidInput, "El número internacional contiene caracteres no admitidos.");
  }
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new ExtensionError(ERROR_CODES.invalidInput, "El número debe contener entre 8 y 15 dígitos internacionales.");
  }
  const countryCodeFirstDigit = digits[0];
  if (!countryCodeFirstDigit || countryCodeFirstDigit === "0") {
    throw new ExtensionError(ERROR_CODES.invalidInput, "El código de país no puede comenzar con cero.");
  }
  return { e164: `+${digits}`, digits, masked: maskPhone(`+${digits}`) };
}

export function maskPhone(value: string): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  const visibleStart = digits.slice(0, Math.min(2, digits.length));
  const visibleEnd = digits.length > 4 ? digits.slice(-4) : "";
  return `+${visibleStart}${"*".repeat(Math.max(4, digits.length - visibleStart.length - visibleEnd.length))}${visibleEnd}`;
}
