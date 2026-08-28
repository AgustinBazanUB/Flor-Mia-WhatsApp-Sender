import { readFile, writeFile } from "node:fs/promises";

const path = "src/content/whatsapp.ts";
let source = await readFile(path, "utf8");

function replaceOnce(from, to) {
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`Expected content source not found: ${from.slice(0, 140)}`);
  source = source.replace(from, to);
}

replaceOnce(
`import { snapshotRuntimeMetrics } from "../performance/runtime-metrics";`,
`import { snapshotRuntimeMetrics } from "../performance/runtime-metrics";\nimport {\n  collectContactsForLabels,\n  detectWhatsAppLabels\n} from "../contact-export/whatsapp-contact-adapter";\nimport { CONTACT_EXPORT_ERROR_CODES } from "../contact-export/types";`
);

replaceOnce(
`const proofControllers = new Map<string, AbortController>();\ninstallConversationInteractionGuard(document);`,
`const proofControllers = new Map<string, AbortController>();\nconst contactExportControllers = new Map<string, AbortController>();\ninstallConversationInteractionGuard(document);`
);

replaceOnce(
`  if (message.type === INTERNAL_MESSAGE_TYPES.whatsappCancelOperation) {\n    const payload = message.payload as InternalRequestMap["WA_CANCEL_OPERATION"];\n    const controller = proofControllers.get(payload.operationId);\n    controller?.abort();\n    sendResponse(success<InternalResponseMap["WA_CANCEL_OPERATION"]>(message.requestId, { cancelled: Boolean(controller) }));\n    return false;\n  }`,
`  if (message.type === INTERNAL_MESSAGE_TYPES.whatsappCancelOperation) {\n    const payload = message.payload as InternalRequestMap["WA_CANCEL_OPERATION"];\n    const controller = proofControllers.get(payload.operationId);\n    controller?.abort();\n    sendResponse(success<InternalResponseMap["WA_CANCEL_OPERATION"]>(message.requestId, { cancelled: Boolean(controller) }));\n    return false;\n  }\n\n  if (message.type === INTERNAL_MESSAGE_TYPES.whatsappContactExportCancel) {\n    const payload = message.payload as InternalRequestMap["WA_CONTACT_EXPORT_CANCEL"];\n    const controller = contactExportControllers.get(payload.operationId);\n    controller?.abort();\n    sendResponse(success<InternalResponseMap["WA_CONTACT_EXPORT_CANCEL"]>(message.requestId, { cancelled: Boolean(controller) }));\n    return false;\n  }`
);

replaceOnce(
`          activeProofControllers: proofControllers.size,\n          runtimeMetrics: snapshotRuntimeMetrics() as unknown as Record<string, unknown>`,
`          activeProofControllers: proofControllers.size,\n          activeContactExportControllers: contactExportControllers.size,\n          runtimeMetrics: snapshotRuntimeMetrics() as unknown as Record<string, unknown>`
);

replaceOnce(
`      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappPreflight) {\n        const data = await runWhatsAppPreflight(message.payload as InternalRequestMap["WA_PREFLIGHT"]);\n        sendResponse(success(message.requestId, data));\n        return;\n      }`,
`      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappPreflight) {\n        const data = await runWhatsAppPreflight(message.payload as InternalRequestMap["WA_PREFLIGHT"]);\n        sendResponse(success(message.requestId, data));\n        return;\n      }\n      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappContactExportDetectLabels) {\n        const data = await detectWhatsAppLabels();\n        sendResponse(success<InternalResponseMap["WA_CONTACT_EXPORT_DETECT_LABELS"]>(message.requestId, data));\n        return;\n      }\n      if (message.type === INTERNAL_MESSAGE_TYPES.whatsappContactExportAnalyze) {\n        const payload = message.payload as InternalRequestMap["WA_CONTACT_EXPORT_ANALYZE"];\n        const controller = new AbortController();\n        contactExportControllers.set(payload.operationId, controller);\n        try {\n          const candidates = await collectContactsForLabels(payload.labels, {\n            signal: controller.signal,\n            progress: async (progress) => {\n              await sendRuntimeRequest("whatsapp-content", INTERNAL_MESSAGE_TYPES.contactExportProgress, {\n                operationId: payload.operationId,\n                ...progress\n              });\n            }\n          });\n          sendResponse(success<InternalResponseMap["WA_CONTACT_EXPORT_ANALYZE"]>(message.requestId, {\n            candidates,\n            strategy: "semantic-label-iteration"\n          }));\n        } catch (error) {\n          if (error instanceof DOMException && error.name === "AbortError") {\n            throw new ExtensionError(ERROR_CODES.contactExportCancelled, "La extracción de contactos fue cancelada.", {\n              recoverable: true,\n              details: {\n                contactExportCode: CONTACT_EXPORT_ERROR_CODES.cancelled,\n                stage: "cancelled",\n                strategy: "semantic-label-iteration"\n              }\n            });\n          }\n          throw error;\n        } finally {\n          if (contactExportControllers.get(payload.operationId) === controller) contactExportControllers.delete(payload.operationId);\n        }\n        return;\n      }`
);

await writeFile(path, source);
