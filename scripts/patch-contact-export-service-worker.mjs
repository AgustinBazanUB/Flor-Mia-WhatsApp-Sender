import { readFile, writeFile } from "node:fs/promises";

const path = "src/background/service-worker.ts";
let source = await readFile(path, "utf8");

function replaceOnce(from, to) {
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`Expected service-worker source not found: ${from.slice(0, 140)}`);
  source = source.replace(from, to);
}

replaceOnce(
`import { activeControlControllerCount, campaignControlIntent } from "./control-intent";`,
`import { activeControlControllerCount, campaignControlIntent } from "./control-intent";\nimport { ContactExportStore } from "../contact-export/contact-export-store";\nimport { ContactExportRuntime } from "./contact-export-runtime";\nimport type { ContactExportState } from "../contact-export/types";`
);

replaceOnce(
`const checkpointStore = new ContactCheckpointStore();\nconst whatsappTransport = new WhatsAppTransport();`,
`const checkpointStore = new ContactCheckpointStore();\nconst whatsappTransport = new WhatsAppTransport();\nconst contactExportStore = new ContactExportStore();\nconst contactExportRuntime = new ContactExportRuntime(contactExportStore, whatsappTransport);`
);

replaceOnce(
`let initializationPromise: Promise<void> | null = null;`,
`async function assertSenderCanMutateWhatsApp(): Promise<void> {\n  const contactExport = await contactExportRuntime.getState();\n  if (["detecting_labels", "analyzing", "cancelling"].includes(contactExport.status)) {\n    throw new ExtensionError(ERROR_CODES.campaignConflict, "Finalizá o cancelá la exportación de contactos antes de usar el sender.");\n  }\n}\n\nasync function assertContactExportCanRun(): Promise<void> {\n  const campaign = await campaignRuntime.campaignStore.loadActive();\n  if (campaign && !["completed", "stopped"].includes(campaign.status)) {\n    throw new ExtensionError(ERROR_CODES.campaignConflict, "Hay una campaña activa. Pausala o detenela antes de analizar contactos de WhatsApp.");\n  }\n  const checkpoint = await checkpointStore.loadActive();\n  if (checkpoint && !["completed", "failed"].includes(checkpoint.status)) {\n    throw new ExtensionError(ERROR_CODES.campaignConflict, "Hay un contacto de prueba activo o pausado. Finalizalo antes de analizar contactos de WhatsApp.");\n  }\n}\n\nfunction contactExportDiagnosticSnapshot(state: ContactExportState): Record<string, unknown> {\n  return {\n    status: state.status,\n    labelsDetected: state.labels.length,\n    selectedLabels: state.labels\n      .filter((label) => state.selectedLabelIds.includes(label.id))\n      .map((label) => label.name),\n    summary: state.summary,\n    progress: state.progress ? {\n      processed: state.progress.processed,\n      totalHint: state.progress.totalHint,\n      percent: state.progress.percent,\n      currentLabel: state.progress.currentLabel,\n      labelIndex: state.progress.labelIndex,\n      totalLabels: state.progress.totalLabels,\n      currentContact: state.progress.currentContact,\n      updatedAt: state.progress.updatedAt\n    } : null,\n    diagnostic: state.diagnostic\n  };\n}\n\nlet initializationPromise: Promise<void> | null = null;`
);

replaceOnce(
`async function sendTestText(payload: InternalRequestMap["SEND_TEST_TEXT"]): Promise<TextTestResult> {\n  const operationId = createId("text-test");`,
`async function sendTestText(payload: InternalRequestMap["SEND_TEST_TEXT"]): Promise<TextTestResult> {\n  await assertSenderCanMutateWhatsApp();\n  const operationId = createId("text-test");`
);

replaceOnce(
`async function processTestContact(\n  payload: InternalRequestMap["PROCESS_TEST_CONTACT"]\n): Promise<ContactProcessCheckpoint> {\n  const activeCampaign = await campaignRuntime.campaignStore.loadActive();`,
`async function processTestContact(\n  payload: InternalRequestMap["PROCESS_TEST_CONTACT"]\n): Promise<ContactProcessCheckpoint> {\n  await assertSenderCanMutateWhatsApp();\n  const activeCampaign = await campaignRuntime.campaignStore.loadActive();`
);

replaceOnce(
`  const runtimeMetrics = snapshotRuntimeMetrics();\n  const report = createDiagnosticReportBundle({`,
`  const runtimeMetrics = snapshotRuntimeMetrics();\n  const contactExport = await contactExportRuntime.getState();\n  const report = createDiagnosticReportBundle({`
);

replaceOnce(
`      whatsapp: whatsappSnapshot,\n      webAppBridge: payload.webAppContext ?? null`,
`      whatsapp: whatsappSnapshot,\n      webAppBridge: payload.webAppContext ?? null,\n      contactExport: contactExportDiagnosticSnapshot(contactExport)`
);

replaceOnce(
`  if (request.source === "diagnostics-page") return sender.url?.startsWith(\`chrome-extension://${chrome.runtime.id}/diagnostics/\`) === true;\n  if (request.source === "whatsapp-content") return sender.url?.startsWith("https://web.whatsapp.com/") === true;`,
`  if (request.source === "diagnostics-page") return sender.url?.startsWith(\`chrome-extension://${chrome.runtime.id}/diagnostics/\`) === true;\n  if (request.source === "contact-export-page") return sender.url?.startsWith(\`chrome-extension://${chrome.runtime.id}/contacts/\`) === true;\n  if (request.source === "whatsapp-content") return sender.url?.startsWith("https://web.whatsapp.com/") === true;`
);

replaceOnce(
`    case INTERNAL_MESSAGE_TYPES.reselectContactImages:\n      return reselectContactImages(request.payload as InternalRequestMap["RESELECT_CONTACT_IMAGES"]);\n    case INTERNAL_MESSAGE_TYPES.campaignStart:`,
`    case INTERNAL_MESSAGE_TYPES.reselectContactImages:\n      return reselectContactImages(request.payload as InternalRequestMap["RESELECT_CONTACT_IMAGES"]);\n    case INTERNAL_MESSAGE_TYPES.contactExportGetState:\n      return contactExportRuntime.getState();\n    case INTERNAL_MESSAGE_TYPES.contactExportDetectLabels:\n      await assertContactExportCanRun();\n      return contactExportRuntime.detectLabels();\n    case INTERNAL_MESSAGE_TYPES.contactExportAnalyze:\n      await assertContactExportCanRun();\n      return contactExportRuntime.analyze((request.payload as InternalRequestMap["CONTACT_EXPORT_ANALYZE"]).selectedLabelIds);\n    case INTERNAL_MESSAGE_TYPES.contactExportCancel:\n      return contactExportRuntime.cancel();\n    case INTERNAL_MESSAGE_TYPES.contactExportReset:\n      return contactExportRuntime.reset();\n    case INTERNAL_MESSAGE_TYPES.contactExportProgress:\n      if (request.source !== "whatsapp-content") {\n        throw new ExtensionError(ERROR_CODES.protocolError, "Sólo WhatsApp Content Script puede informar progreso de exportación.", { recoverable: false });\n      }\n      return contactExportRuntime.recordProgress(request.payload as InternalRequestMap["CONTACT_EXPORT_PROGRESS"]);\n    case INTERNAL_MESSAGE_TYPES.campaignStart:\n      await assertSenderCanMutateWhatsApp();`
);

replaceOnce(
`async function executeWebAppPrepare(request: InternalEnvelope): Promise<CampaignPublicStatus> {\n  const payload = request.payload as SerializedCampaignPayload;`,
`async function executeWebAppPrepare(request: InternalEnvelope): Promise<CampaignPublicStatus> {\n  await assertSenderCanMutateWhatsApp();\n  const payload = request.payload as SerializedCampaignPayload;`
);

await writeFile(path, source);
