export const ERROR_CODES = {
  whatsappNotOpen: "WHATSAPP_NOT_OPEN",
  sessionNotReady: "SESSION_NOT_READY",
  interfaceLoading: "INTERFACE_LOADING",
  invalidContact: "INVALID_CONTACT",
  contactUnavailable: "CONTACT_UNAVAILABLE",
  elementNotFound: "ELEMENT_NOT_FOUND",
  timeout: "TIMEOUT",
  verificationFailed: "VERIFICATION_FAILED",
  attachmentUnavailable: "ATTACHMENT_UNAVAILABLE",
  imageLoadFailed: "IMAGE_LOAD_FAILED",
  previewUnavailable: "PREVIEW_UNAVAILABLE",
  imageMissing: "IMAGE_MISSING",
  ambiguousResult: "AMBIGUOUS_RESULT",
  retryLimit: "RETRY_LIMIT",
  dailyLimitReached: "DAILY_LIMIT_REACHED",
  campaignConflict: "CAMPAIGN_CONFLICT",
  campaignStopped: "CAMPAIGN_STOPPED",
  invalidInput: "INVALID_INPUT",
  protocolError: "PROTOCOL_ERROR",
  storageError: "STORAGE_ERROR",
  internal: "INTERNAL_ERROR"
} as const;

export type ExtensionErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
const knownErrorCodes = new Set<string>(Object.values(ERROR_CODES));

export function isExtensionErrorCode(value: unknown): value is ExtensionErrorCode {
  return typeof value === "string" && knownErrorCodes.has(value);
}

export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;
  readonly details?: Record<string, unknown>;
  readonly recoverable: boolean;

  constructor(code: ExtensionErrorCode, message: string, options: { details?: Record<string, unknown>; recoverable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ExtensionError";
    this.code = code;
    this.details = options.details;
    this.recoverable = options.recoverable ?? true;
  }
}

export interface SerializedExtensionError {
  code: ExtensionErrorCode;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export function toExtensionError(error: unknown, fallbackCode: ExtensionErrorCode = ERROR_CODES.internal): ExtensionError {
  if (error instanceof ExtensionError) return error;
  return new ExtensionError(fallbackCode, error instanceof Error ? error.message : "Ocurrió un error interno.", { cause: error });
}

export function serializeError(error: unknown): SerializedExtensionError {
  const normalized = toExtensionError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    recoverable: normalized.recoverable,
    ...(normalized.details ? { details: normalized.details } : {})
  };
}
