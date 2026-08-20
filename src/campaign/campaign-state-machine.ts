import { ERROR_CODES, ExtensionError } from "../shared/errors";
import type { CampaignStatus } from "./campaign-types";

const transitions: Record<CampaignStatus, ReadonlySet<CampaignStatus>> = {
  received: new Set(["ready", "stopped", "cancelled", "error"]),
  ready: new Set(["running", "pause_requested", "paused", "daily_limit_reached", "stopped", "cancelled", "error"]),
  running: new Set(["pause_requested", "paused", "waiting_contact", "waiting_batch", "daily_limit_reached", "images_required", "stopped", "cancelled", "completed", "error"]),
  pause_requested: new Set(["paused", "images_required", "stopped", "cancelled", "completed", "error"]),
  paused: new Set(["ready", "running", "stopped", "cancelled", "error", "images_required", "daily_limit_reached", "completed"]),
  waiting_contact: new Set(["running", "pause_requested", "paused", "daily_limit_reached", "stopped", "cancelled", "completed", "error"]),
  waiting_batch: new Set(["running", "pause_requested", "paused", "daily_limit_reached", "stopped", "cancelled", "completed", "error"]),
  daily_limit_reached: new Set(["ready", "running", "paused", "stopped", "cancelled", "error"]),
  images_required: new Set(["paused", "ready", "running", "stopped", "cancelled", "error"]),
  error: new Set(["ready", "running", "paused", "stopped", "cancelled"]),
  stopped: new Set(["cancelled"]),
  cancelled: new Set(),
  completed: new Set(["ready", "running", "daily_limit_reached"])
};

export function canCampaignTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return from === to || transitions[from].has(to);
}

export function assertCampaignTransition(from: CampaignStatus, to: CampaignStatus): void {
  if (!canCampaignTransition(from, to)) {
    throw new ExtensionError(ERROR_CODES.internal, `Transición de campaña inválida: ${from} → ${to}.`, {
      recoverable: false,
      details: { from, to }
    });
  }
}
