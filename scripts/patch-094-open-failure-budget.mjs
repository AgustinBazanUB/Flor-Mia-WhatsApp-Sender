import { readFile, writeFile } from "node:fs/promises";

const path = "src/engine/contact-engine.ts";
let source = await readFile(path, "utf8");

const replacements = [
  [
`  // Presupuesto TOTAL por contacto, atravesando Resume. Nunca se renueva una\n  // ventana de tres intentos sólo porque el usuario vuelva a pulsar Reanudar.\n  const openConversationAttemptLimit = policy.maxOpenConversationAttempts ?? Math.min(2, policy.maxAttemptsPerStep);`,
`  // Presupuesto TOTAL de APERTURAS FALLIDAS por contacto, atravesando Resume.\n  // Las aperturas confirmadas siguen contando en openConversationAttempts para\n  // diagnóstico, pero no bloquean una reconciliación segura posterior.\n  const openConversationFailureLimit = policy.maxOpenConversationAttempts ?? Math.min(2, policy.maxAttemptsPerStep);`
  ],
  [
`  let opened = false;\n  while (!opened && checkpoint.openConversationAttempts < openConversationAttemptLimit) {`,
`  let opened = false;\n  while (!opened && (checkpoint.openConversationFailures ?? 0) < openConversationFailureLimit) {`
  ],
  [
`      const normalized = toExtensionError(error);\n      checkpoint = await persist({ ...checkpoint, error: serializeError(normalized) });\n      const retryWithoutNewEvidence = normalized.details?.retryWithoutNewEvidence !== false;\n      if (!normalized.recoverable || !retryWithoutNewEvidence || checkpoint.openConversationAttempts >= openConversationAttemptLimit) {`,
`      const normalized = toExtensionError(error);\n      const openConversationFailures = (checkpoint.openConversationFailures ?? 0) + 1;\n      checkpoint = await persist({\n        ...checkpoint,\n        openConversationFailures,\n        error: serializeError(normalized)\n      });\n      const retryWithoutNewEvidence = normalized.details?.retryWithoutNewEvidence !== false;\n      if (!normalized.recoverable || !retryWithoutNewEvidence || openConversationFailures >= openConversationFailureLimit) {`
  ],
  [
`      await sleepWithSignal(sleep, retryDelayMs(checkpoint.openConversationAttempts, policy), dependencies.signal);`,
`      await sleepWithSignal(sleep, retryDelayMs(checkpoint.openConversationFailures ?? 1, policy), dependencies.signal);`
  ]
];

for (const [from, to] of replacements) {
  if (source.includes(to)) continue;
  if (!source.includes(from)) throw new Error(`Expected source not found: ${from.slice(0, 100)}`);
  source = source.replace(from, to);
}

await writeFile(path, source);
