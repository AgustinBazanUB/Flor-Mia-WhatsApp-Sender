import { maskPhone } from "../shared/phone";
import { normalizeExportPhoneCandidate } from "./phone-normalizer";
import {
  CONTACT_EXPORT_ERROR_CODES,
  type ContactExportAnalysisResult,
  type ContactExportDiagnostic,
  type ContactExportProblem,
  type ExportContact,
  type RawContactCandidate
} from "./types";

function correlationId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `contact_${hash.toString(36).padStart(7, "0")}`;
}

function zoneFromLabels(labels: string[]): string {
  return labels.join(" | ");
}

function baseDiagnostic(processedCount: number): ContactExportDiagnostic {
  return {
    status: "green",
    lastSuccessfulStep: "contact_deduplication",
    failedStep: null,
    labelName: null,
    strategy: "phone-key",
    expectedElement: null,
    candidateCount: processedCount,
    processedCount,
    reportedCount: null,
    collectedUniqueContacts: processedCount,
    lastContactCorrelationId: null,
    errorCode: null,
    errorMessage: null,
    stack: null,
    technicalDetails: {},
    updatedAt: new Date().toISOString()
  };
}

export function deduplicateContactCandidates(candidates: RawContactCandidate[]): ContactExportAnalysisResult {
  const byPhone = new Map<string, ExportContact>();
  const problems: ContactExportProblem[] = [];
  let duplicatesRemoved = 0;
  let withoutPhone = 0;
  let excludedNonContacts = 0;

  for (const candidate of candidates) {
    if (candidate.kind !== "contact" && candidate.kind !== "unknown") {
      excludedNonContacts += 1;
      problems.push({
        problemId: correlationId(`${candidate.sourceId}:${candidate.labelName}:non-contact`),
        labelName: candidate.labelName,
        maskedPhone: null,
        namePresent: Boolean(candidate.name.trim()),
        reason: "NON_CONTACT",
        strategy: candidate.strategy
      });
      continue;
    }

    const normalized = candidate.phoneCandidate && candidate.phoneSource !== "none"
      ? normalizeExportPhoneCandidate(candidate.phoneCandidate, candidate.phoneSource)
      : null;
    if (!normalized || candidate.phoneStatus !== "resolved") {
      withoutPhone += 1;
      problems.push({
        problemId: correlationId(`${candidate.sourceId}:${candidate.labelName}:phone`),
        labelName: candidate.labelName,
        maskedPhone: null,
        namePresent: Boolean(candidate.name.trim()),
        reason: candidate.phoneStatus === "invalid" ? CONTACT_EXPORT_ERROR_CODES.phoneInvalid : CONTACT_EXPORT_ERROR_CODES.phoneUnresolved,
        strategy: candidate.strategy
      });
      continue;
    }

    const key = normalized.digits;
    const existing = byPhone.get(key);
    const cleanName = candidate.name.trim().replace(/\s+/g, " ");
    if (existing) {
      duplicatesRemoved += 1;
      if (!existing.labels.includes(candidate.labelName)) existing.labels.push(candidate.labelName);
      if (!existing.name && cleanName) existing.name = cleanName;
      if (!existing.sourceIds.includes(candidate.sourceId)) existing.sourceIds.push(candidate.sourceId);
      existing.zone = zoneFromLabels(existing.labels);
      continue;
    }

    byPhone.set(key, {
      phone: normalized.e164,
      name: cleanName,
      zone: candidate.labelName,
      labels: [candidate.labelName],
      sourceIds: [candidate.sourceId]
    });
  }

  const contacts = [...byPhone.values()];
  const diagnostic = baseDiagnostic(candidates.length);
  if (contacts.length) diagnostic.lastContactCorrelationId = correlationId(contacts.at(-1)?.sourceIds[0] ?? contacts.at(-1)?.phone ?? "last");

  return {
    contacts,
    problems,
    summary: {
      found: candidates.length,
      valid: contacts.length,
      duplicatesRemoved,
      withoutPhone,
      withoutName: contacts.filter((contact) => !contact.name).length,
      excludedNonContacts
    },
    diagnostic
  };
}

export function maskedExportPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  try { return maskPhone(phone); } catch { return null; }
}
