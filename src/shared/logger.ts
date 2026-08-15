import { maskPhone } from "./phone";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogContext { [key: string]: unknown }

const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/g;

export function redactLogValue(value: unknown, key = ""): unknown {
  if (/message|text|body|conversation|credential|cookie|token|password/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(PHONE_PATTERN, (phone) => maskPhone(phone));
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactLogValue(childValue, childKey)]));
  }
  return value;
}

function write(level: LogLevel, event: string, context: LogContext = {}): void {
  const entry = { scope: "flor-mia-whatsapp-sender", event, ...redactLogValue(context) as object };
  const method = level === "debug" ? console.debug : level === "info" ? console.info : level === "warn" ? console.warn : console.error;
  method(entry);
}

export const logger = {
  debug: (event: string, context?: LogContext) => write("debug", event, context),
  info: (event: string, context?: LogContext) => write("info", event, context),
  warn: (event: string, context?: LogContext) => write("warn", event, context),
  error: (event: string, context?: LogContext) => write("error", event, context)
};
