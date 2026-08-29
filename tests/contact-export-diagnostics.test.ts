import { describe, expect, it } from "vitest";
import { createContactExportDiagnosticBundle } from "../src/contact-export/contact-export-diagnostics";
import { emptyContactExportState } from "../src/contact-export/contact-export-store";

describe("contact export diagnostics", () => {
  it("includes label scope and performance context but never contact names or phone numbers", () => {
    const state = emptyContactExportState(new Date("2026-08-28T22:00:00.000Z"));
    state.status = "error";
    state.labels = [{
      id: "label-1",
      name: "Zona Tribunales",
      countHint: 10,
      countHintStrategy: "dedicated-count",
      sourceId: "label-structured-1",
      strategy: "semantic-label-hub+structured-id"
    }];
    state.selectedLabelIds = ["label-1"];
    state.contacts = [{ phone: "+5491123456789", name: "Juan Pérez", zone: "Zona Tribunales", labels: ["Zona Tribunales"], sourceIds: ["secret-source"] }];
    state.metrics = {
      startedAt: "2026-08-28T22:00:00.000Z",
      completedAt: "2026-08-28T22:00:01.000Z",
      durationMs: 1000,
      contactsPerSecond: 10,
      labelsProcessed: 1,
      rowScans: 11,
      scrollOperations: 1,
      visualOperations: 2,
      chatsOpened: 0
    };
    state.diagnostic = {
      status: "red",
      lastSuccessfulStep: "labels_detected",
      failedStep: "label_scoped_contact_extraction",
      labelName: "Zona Tribunales",
      strategy: "selected-label-marker+scoped-list",
      expectedElement: "Listado exclusivo de la etiqueta seleccionada",
      candidateCount: 11,
      processedCount: 11,
      reportedCount: 10,
      collectedUniqueContacts: 11,
      lastContactCorrelationId: "contact_abcd123",
      errorCode: "EXTRACTION_SCOPE_BROKEN",
      errorMessage: "La extracción obtuvo más elementos que la cantidad informada por la etiqueta.",
      stack: "Error: scope mismatch",
      technicalDetails: { scopeCandidateCount: 2, visibleRows: 1, scrollState: "end", scopeCandidateSummary: "div[role=list] rows=1 scroll=no" },
      updatedAt: "2026-08-28T22:00:01.000Z"
    };
    const bundle = createContactExportDiagnosticBundle(state, "0.9.5.2", "2026-08-28T22:00:02.000Z");
    expect(bundle.text).toContain("CONTACT EXPORT DIAGNOSTIC");
    expect(bundle.text).toContain("label_scoped_contact_extraction");
    expect(bundle.text).toContain("Reported contacts: 10");
    expect(bundle.text).toContain("Collected unique contacts: 11");
    expect(bundle.text).toContain("Chats abiertos durante extracción normal: 0");
    expect(bundle.text).toContain("scopeCandidateCount");
    expect(bundle.json).toContain("visibleRows");
    expect(bundle.text).not.toContain("Juan Pérez");
    expect(bundle.text).not.toContain("+5491123456789");
    expect(bundle.json).not.toContain("Juan Pérez");
    expect(bundle.json).not.toContain("5491123456789");
  });
});
