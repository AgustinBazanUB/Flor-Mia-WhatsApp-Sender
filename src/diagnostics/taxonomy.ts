import { ERROR_CODES, type ExtensionErrorCode, type SerializedExtensionError } from "../shared/errors";
import type { DiagnosticErrorCategory } from "./types";

const CATEGORY_BY_CODE: Partial<Record<ExtensionErrorCode, DiagnosticErrorCategory>> = {
  [ERROR_CODES.storageError]: "EXTENSION_ERROR",
  [ERROR_CODES.protocolError]: "EXTENSION_ERROR",
  [ERROR_CODES.invalidInput]: "EXTENSION_ERROR",
  [ERROR_CODES.campaignConflict]: "EXTENSION_ERROR",
  [ERROR_CODES.campaignStopped]: "USER_STOP",
  [ERROR_CODES.internal]: "EXTENSION_ERROR",
  [ERROR_CODES.interfaceLoading]: "TEMPORARY_WHATSAPP_ERROR",
  [ERROR_CODES.timeout]: "TEMPORARY_WHATSAPP_ERROR",
  [ERROR_CODES.previewUnavailable]: "TEMPORARY_WHATSAPP_ERROR",
  [ERROR_CODES.retryLimit]: "TEMPORARY_WHATSAPP_ERROR",
  [ERROR_CODES.whatsappNotOpen]: "TEMPORARY_WHATSAPP_ERROR",
  [ERROR_CODES.invalidContact]: "CONTACT_ERROR",
  [ERROR_CODES.contactUnavailable]: "CONTACT_ERROR",
  [ERROR_CODES.sessionNotReady]: "AUTH_ERROR",
  [ERROR_CODES.capabilityUnavailable]: "WHATSAPP_UI_CHANGED",
  [ERROR_CODES.whatsappUiChanged]: "WHATSAPP_UI_CHANGED",
  [ERROR_CODES.selectorStrategyExhausted]: "WHATSAPP_UI_CHANGED",
  [ERROR_CODES.preflightFailed]: "WHATSAPP_UI_CHANGED",
  [ERROR_CODES.ambiguousResult]: "AMBIGUOUS_SEND_RESULT",
  [ERROR_CODES.verificationFailed]: "AMBIGUOUS_SEND_RESULT",
  [ERROR_CODES.imageMissing]: "RESOURCE_ERROR",
  [ERROR_CODES.imageLoadFailed]: "RESOURCE_ERROR",
  [ERROR_CODES.attachmentUnavailable]: "WHATSAPP_UI_CHANGED",
  [ERROR_CODES.elementNotFound]: "WHATSAPP_UI_CHANGED",
  [ERROR_CODES.dailyLimitReached]: "DAILY_LIMIT"
};

export interface DiagnosticClassificationContext {
  online?: boolean | null;
  campaignBlockCode?: string | null;
  pauseReason?: string | null;
}

export function classifyDiagnosticError(
  error: Pick<SerializedExtensionError, "code"> | null | undefined,
  context: DiagnosticClassificationContext = {}
): DiagnosticErrorCategory {
  if (context.campaignBlockCode === "manual_pause" || context.pauseReason === "manual_pause") return "USER_PAUSE";
  if (context.campaignBlockCode === "user_stop" || context.campaignBlockCode === "stopped") return "USER_STOP";
  if (context.campaignBlockCode === "daily_limit_reached") return "DAILY_LIMIT";
  if (context.campaignBlockCode === "images_required" || context.pauseReason === "images_required") return "RESOURCE_ERROR";
  if (context.campaignBlockCode === "contact_ambiguous" || context.pauseReason === "verification_pending") return "AMBIGUOUS_SEND_RESULT";
  if (context.campaignBlockCode === "whatsapp_session_closed") return "AUTH_ERROR";
  if (context.campaignBlockCode === "whatsapp_tab_closed") return "CONNECTION_ERROR";
  if (context.campaignBlockCode === "whatsapp_reloading") return "TEMPORARY_WHATSAPP_ERROR";
  if (context.campaignBlockCode === "whatsapp_ui_changed") return "WHATSAPP_UI_CHANGED";
  if (
    context.online === false &&
    (error?.code === ERROR_CODES.whatsappNotOpen || error?.code === ERROR_CODES.interfaceLoading || error?.code === ERROR_CODES.timeout)
  ) {
    return "CONNECTION_ERROR";
  }
  return error ? CATEGORY_BY_CODE[error.code] ?? "EXTENSION_ERROR" : "EXTENSION_ERROR";
}
