import { readFile, writeFile } from "node:fs/promises";

const path = "src/shared/protocol.ts";
let source = await readFile(path, "utf8");

function replaceOnce(from, to) {
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`Expected protocol source not found: ${from.slice(0, 120)}`);
  source = source.replace(from, to);
}

replaceOnce(
`import type { ConversationContextProof } from "../whatsapp/conversation-context";`,
`import type { ConversationContextProof } from "../whatsapp/conversation-context";\nimport type {\n  ContactExportProgress,\n  ContactExportState,\n  RawContactCandidate,\n  WhatsAppLabelInfo\n} from "../contact-export/types";`
);

replaceOnce(
`  campaignRestoreImages: "CAMPAIGN_RESTORE_IMAGES",\n  whatsappPreflight: "WA_PREFLIGHT",`,
`  campaignRestoreImages: "CAMPAIGN_RESTORE_IMAGES",\n  contactExportGetState: "CONTACT_EXPORT_GET_STATE",\n  contactExportDetectLabels: "CONTACT_EXPORT_DETECT_LABELS",\n  contactExportAnalyze: "CONTACT_EXPORT_ANALYZE",\n  contactExportCancel: "CONTACT_EXPORT_CANCEL",\n  contactExportReset: "CONTACT_EXPORT_RESET",\n  contactExportProgress: "CONTACT_EXPORT_PROGRESS",\n  whatsappContactExportDetectLabels: "WA_CONTACT_EXPORT_DETECT_LABELS",\n  whatsappContactExportAnalyze: "WA_CONTACT_EXPORT_ANALYZE",\n  whatsappContactExportCancel: "WA_CONTACT_EXPORT_CANCEL",\n  whatsappPreflight: "WA_PREFLIGHT",`
);

replaceOnce(
`export type InternalSource = "popup" | "diagnostics-page" | "service-worker" | "whatsapp-content" | "web-app-bridge";`,
`export type InternalSource = "popup" | "diagnostics-page" | "contact-export-page" | "service-worker" | "whatsapp-content" | "web-app-bridge";`
);

replaceOnce(
`  CAMPAIGN_RESTORE_IMAGES: { campaignId: string; images: SerializedCampaignImage[] };\n  WA_PREFLIGHT: WhatsAppPreflightRequest;`,
`  CAMPAIGN_RESTORE_IMAGES: { campaignId: string; images: SerializedCampaignImage[] };\n  CONTACT_EXPORT_GET_STATE: Record<string, never>;\n  CONTACT_EXPORT_DETECT_LABELS: Record<string, never>;\n  CONTACT_EXPORT_ANALYZE: { selectedLabelIds: string[] };\n  CONTACT_EXPORT_CANCEL: Record<string, never>;\n  CONTACT_EXPORT_RESET: Record<string, never>;\n  CONTACT_EXPORT_PROGRESS: Omit<ContactExportProgress, "updatedAt">;\n  WA_CONTACT_EXPORT_DETECT_LABELS: { operationId: string };\n  WA_CONTACT_EXPORT_ANALYZE: { operationId: string; labels: WhatsAppLabelInfo[] };\n  WA_CONTACT_EXPORT_CANCEL: { operationId: string };\n  WA_PREFLIGHT: WhatsAppPreflightRequest;`
);

replaceOnce(
`  CAMPAIGN_RESTORE_IMAGES: CampaignPublicStatus;\n  WA_PREFLIGHT: WhatsAppPreflightResult;`,
`  CAMPAIGN_RESTORE_IMAGES: CampaignPublicStatus;\n  CONTACT_EXPORT_GET_STATE: ContactExportState;\n  CONTACT_EXPORT_DETECT_LABELS: ContactExportState;\n  CONTACT_EXPORT_ANALYZE: ContactExportState;\n  CONTACT_EXPORT_CANCEL: ContactExportState;\n  CONTACT_EXPORT_RESET: ContactExportState;\n  CONTACT_EXPORT_PROGRESS: ContactExportState;\n  WA_CONTACT_EXPORT_DETECT_LABELS: { labels: WhatsAppLabelInfo[]; strategy: string; candidateCount: number };\n  WA_CONTACT_EXPORT_ANALYZE: { candidates: RawContactCandidate[]; strategy: string };\n  WA_CONTACT_EXPORT_CANCEL: { cancelled: boolean };\n  WA_PREFLIGHT: WhatsAppPreflightResult;`
);

replaceOnce(
`    && ["popup", "diagnostics-page", "service-worker", "whatsapp-content", "web-app-bridge"].includes(String(value.source))`,
`    && ["popup", "diagnostics-page", "contact-export-page", "service-worker", "whatsapp-content", "web-app-bridge"].includes(String(value.source))`
);

await writeFile(path, source);
