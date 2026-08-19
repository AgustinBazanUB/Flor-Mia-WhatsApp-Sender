import { readFile, writeFile } from "node:fs/promises";

async function patch(path, replacements) {
  let source = await readFile(path, "utf8");
  let changed = false;
  for (const [from, to] of replacements) {
    if (source.includes(to)) continue;
    if (!source.includes(from)) throw new Error(`Expected source not found in ${path}: ${from.slice(0, 100)}`);
    source = source.replace(from, to);
    changed = true;
  }
  if (changed) await writeFile(path, source);
  return changed;
}

const contactChanged = await patch("src/engine/contact-engine.ts", [
  [
    `  // Los intentos de apertura son acumulativos para diagnóstico, pero cada\n  // invocación explícita dispone de su propia ventana acotada de reintentos.\n  const openConversationAttemptLimit = checkpoint.openConversationAttempts + policy.maxAttemptsPerStep;`,
    `  // Presupuesto TOTAL por contacto, atravesando Resume. Nunca se renueva una\n  // ventana de tres intentos sólo porque el usuario vuelva a pulsar Reanudar.\n  const openConversationAttemptLimit = policy.maxOpenConversationAttempts ?? Math.min(2, policy.maxAttemptsPerStep);`
  ],
  [
    `      if (!normalized.recoverable || checkpoint.openConversationAttempts >= openConversationAttemptLimit) {`,
    `      const retryWithoutNewEvidence = normalized.details?.retryWithoutNewEvidence !== false;\n      if (!normalized.recoverable || !retryWithoutNewEvidence || checkpoint.openConversationAttempts >= openConversationAttemptLimit) {`
  ],
  [
    `  }\n\n  for (const originalStep of checkpoint.steps) {`,
    `  }\n\n  if (!opened) {\n    return persist({\n      ...checkpoint,\n      status: "paused",\n      pauseReason: "open_conversation_failed"\n    });\n  }\n\n  for (const originalStep of checkpoint.steps) {`
  ]
]);

const runtimeChanged = await patch("src/background/campaign-runtime.ts", [
  [
    `    if (!["paused", "daily_limit_reached", "images_required"].includes(current.status)) {\n      throw new ExtensionError(ERROR_CODES.invalidInput, "La campaña no está en un estado que admita reanudación.");\n    }`,
    `    if (["running", "pause_requested", "waiting_contact", "waiting_batch"].includes(current.status)) {\n      // Un segundo Resume con otro requestId puede llegar después de que el primero ya\n      // hizo avanzar la campaña. Se responde con el estado actual en vez de INVALID_INPUT.\n      return this.syncCampaign(current);\n    }\n    if (!["paused", "daily_limit_reached", "images_required"].includes(current.status)) {\n      throw new ExtensionError(ERROR_CODES.invalidInput, "La campaña no está en un estado que admita reanudación.");\n    }`
  ]
]);

console.log(JSON.stringify({ contactChanged, runtimeChanged }));
