import { ERROR_CODES, ExtensionError } from "./errors";
import type { ExtensionStatus } from "./state";

const transitions: Record<ExtensionStatus, ReadonlySet<ExtensionStatus>> = {
  idle: new Set(["preflight", "error"]),
  preflight: new Set(["ready", "error", "idle"]),
  ready: new Set(["preflight", "running", "error", "idle"]),
  running: new Set(["pausing", "completed", "error"]),
  pausing: new Set(["paused", "error"]),
  paused: new Set(["running", "idle", "error"]),
  // Un diagnóstico exitoso puede finalizar después de que otro diagnóstico
  // concurrente haya dejado el estado en `error`. `ready` sólo se solicita
  // cuando el preflight que termina confirmó operational=true, por lo que esta
  // recuperación evita un INTERNAL_ERROR espurio sin permitir iniciar envíos
  // desde error ni saltarse CampaignEngine/ContactEngine.
  error: new Set(["preflight", "idle", "ready"]),
  completed: new Set(["preflight", "idle", "error"])
};

export function canTransition(from: ExtensionStatus, to: ExtensionStatus): boolean {
  return from === to || transitions[from].has(to);
}

export function assertTransition(from: ExtensionStatus, to: ExtensionStatus): void {
  if (!canTransition(from, to)) {
    throw new ExtensionError(ERROR_CODES.internal, `Transición de estado inválida: ${from} → ${to}.`, {
      details: { from, to },
      recoverable: false
    });
  }
}

export function allowedTransitions(from: ExtensionStatus): ExtensionStatus[] {
  return [...transitions[from]];
}
