export const CONTACT_EXPORT_ERROR_CODES = {
  labelsNotFound: "LABELS_NOT_FOUND",
  labelNotFound: "LABEL_NOT_FOUND",
  labelContainerNotFound: "LABEL_CONTAINER_NOT_FOUND",
  contactListNotFound: "CONTACT_LIST_NOT_FOUND",
  labelContactCountMismatch: "LABEL_CONTACT_COUNT_MISMATCH",
  contactIdNotFound: "CONTACT_ID_NOT_FOUND",
  phoneUnresolved: "PHONE_UNRESOLVED",
  phoneInvalid: "PHONE_INVALID",
  phoneNotAvailable: "PHONE_NOT_AVAILABLE",
  virtualListStalled: "VIRTUAL_LIST_STALLED",
  whatsappStructureChanged: "WHATSAPP_STRUCTURE_CHANGED",
  extractionScopeBroken: "EXTRACTION_SCOPE_BROKEN",
  contactExtractionFailed: "CONTACT_EXTRACTION_FAILED",
  whatsappNotReady: "WHATSAPP_NOT_READY",
  exportFailed: "EXPORT_FAILED",
  cancelled: "CONTACT_EXPORT_CANCELLED"
} as const;

export type ContactExportErrorCode = (typeof CONTACT_EXPORT_ERROR_CODES)[keyof typeof CONTACT_EXPORT_ERROR_CODES];

export type ContactExportStatus =
  | "idle"
  | "detecting_labels"
  | "ready"
  | "analyzing"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "error";

export type ContactExportDiagnosticStatus = "unknown" | "green" | "red";

export interface WhatsAppLabelInfo {
  id: string;
  name: string;
  countHint: number | null;
  countHintStrategy: string | null;
  sourceId: string | null;
  strategy: string;
}

export type ContactKind = "contact" | "group" | "community" | "channel" | "status" | "system" | "unknown";
export type PhoneResolutionStatus = "resolved" | "unresolved" | "invalid";
export type ContactPhoneSource = "jid" | "structured_phone" | "tel_link" | "visible_international" | "href_phone" | "none";

export interface RawContactCandidate {
  sourceId: string;
  contactId: string | null;
  labelId: string;
  labelName: string;
  name: string;
  phoneCandidate: string | null;
  phoneSource: ContactPhoneSource;
  phoneStatus: PhoneResolutionStatus;
  kind: ContactKind;
  strategy: string;
}

export interface ExportContact {
  phone: string;
  name: string;
  zone: string;
  labels: string[];
  sourceIds: string[];
}

export interface ContactExportProblem {
  problemId: string;
  labelName: string;
  maskedPhone: string | null;
  namePresent: boolean;
  reason: ContactExportErrorCode | "NON_CONTACT" | "DUPLICATE";
  strategy: string;
}

export interface ContactExportSummary {
  found: number;
  valid: number;
  duplicatesRemoved: number;
  withoutPhone: number;
  withoutName: number;
  excludedNonContacts: number;
}

export interface ContactExportMetrics {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  contactsPerSecond: number | null;
  labelsProcessed: number;
  rowScans: number;
  scrollOperations: number;
  visualOperations: number;
  chatsOpened: number;
}

export interface ContactExportLabelResult {
  labelId: string;
  labelName: string;
  reportedCount: number | null;
  collectedUniqueContacts: number;
  resolvedPhones: number;
  unresolvedPhones: number;
  rowScans: number;
  scrollOperations: number;
  scopeStrategy: string;
}

export interface ContactExportCollectionResult {
  candidates: RawContactCandidate[];
  strategy: string;
  labelResults: ContactExportLabelResult[];
  metrics: ContactExportMetrics;
}

export interface ContactExportProgress {
  operationId: string;
  processed: number;
  totalHint: number | null;
  percent: number | null;
  currentLabel: string | null;
  labelIndex: number;
  totalLabels: number;
  currentContact: number;
  metrics?: ContactExportMetrics;
  labelResults?: ContactExportLabelResult[];
  updatedAt: string;
}

export interface ContactExportDiagnostic {
  status: ContactExportDiagnosticStatus;
  lastSuccessfulStep: string | null;
  failedStep: string | null;
  labelName: string | null;
  strategy: string | null;
  expectedElement: string | null;
  candidateCount: number;
  processedCount: number;
  reportedCount: number | null;
  collectedUniqueContacts: number | null;
  lastContactCorrelationId: string | null;
  errorCode: ContactExportErrorCode | null;
  errorMessage: string | null;
  stack: string | null;
  updatedAt: string;
}

export interface ContactExportState {
  schemaVersion: 1;
  status: ContactExportStatus;
  operationId: string | null;
  labels: WhatsAppLabelInfo[];
  selectedLabelIds: string[];
  contacts: ExportContact[];
  problems: ContactExportProblem[];
  summary: ContactExportSummary;
  progress: ContactExportProgress | null;
  metrics: ContactExportMetrics | null;
  labelResults: ContactExportLabelResult[];
  diagnostic: ContactExportDiagnostic;
  updatedAt: string;
}

export interface ContactExportAnalysisResult {
  contacts: ExportContact[];
  problems: ContactExportProblem[];
  summary: ContactExportSummary;
  diagnostic: ContactExportDiagnostic;
}

export interface ContactExportWorkbookInput {
  contacts: Array<Pick<ExportContact, "phone" | "name" | "zone">>;
  selectedLabels: string[];
  date: Date;
}
