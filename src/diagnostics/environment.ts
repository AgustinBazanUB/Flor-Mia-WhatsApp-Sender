import type { WhatsAppPreflightResult } from "../shared/state";
import { sanitizeDiagnosticUrl } from "./sanitizer";
import type { DiagnosticEnvironment } from "./types";

export interface DiagnosticEnvironmentInput {
  userAgent?: string | null;
  online?: boolean | null;
  whatsappUrl?: string | null;
  preflight?: WhatsAppPreflightResult | null;
  now?: Date;
}

export function buildDiagnosticEnvironment(input: DiagnosticEnvironmentInput = {}): DiagnosticEnvironment {
  const now = input.now ?? new Date();
  const userAgent = input.userAgent ?? null;
  const chromeVersion = userAgent?.match(/(?:Chrome|Chromium)\/([\d.]+)/i)?.[1] ?? null;
  const online = input.online ?? null;
  return {
    chromeVersion,
    sanitizedUserAgent: chromeVersion ? `Chrome/${chromeVersion}` : null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    timezoneOffsetMinutes: now.getTimezoneOffset(),
    online,
    whatsappUrl: sanitizeDiagnosticUrl(input.whatsappUrl),
    connectionState: online === true ? "online" : online === false ? "offline" : "unknown",
    documentReadyState: input.preflight ? input.preflight.documentReady ? "ready" : "loading" : null,
    whatsappLoadState: input.preflight?.status ?? null
  };
}
