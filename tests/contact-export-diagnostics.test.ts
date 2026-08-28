import { describe, expect, it } from "vitest";
import { createContactExportDiagnosticBundle } from "../src/contact-export/contact-export-diagnostics";
import { emptyContactExportState } from "../src/contact-export/contact-export-store";

describe("contact export diagnostics", () => {
  it("includes repair context but never contact names or phone numbers", () => {
    const state = emptyContactExportState(new Date("2026-08-28T22:00:00.000Z"));
    state.status = "error";
    state.labels = [{ id: "label-1", name: "Microcentro", countHint: 3, strategy: "semantic-label-hub" }];
    state.selectedLabelIds = ["label-1"];
    state.contacts = [{ phone: "+5491123456789", name: "Juan Pérez", zone: "Microcentro", labels: ["Microcentro"], sourceIds: ["secret-source"] }];
    state.diagnostic = {
      status: "red",
      lastSuccessfulStep: "labels_detected",
      failedStep: "read_label_contacts",
      labelName: "Microcentro",
      strategy: "semantic-chat-list",
      expectedElement: "Listado de chats/contactos de la etiqueta",
      candidateCount: 3,
      processedCount: 2,
      lastContactCorrelationId: "contact_abcd123",
      errorCode: "CONTACT_LIST_NOT_FOUND",
      errorMessage: "No se encontró el listado esperado.",
      stack: "Error: list not found",
      updatedAt: "2026-08-28T22:00:01.000Z"
    };
    const bundle = createContactExportDiagnosticBundle(state, "0.9.5", "2026-08-28T22:00:02.000Z");
    expect(bundle.text).toContain("CONTACT EXPORT DIAGNOSTIC");
    expect(bundle.text).toContain("read_label_contacts");
    expect(bundle.text).toContain("Microcentro");
    expect(bundle.text).not.toContain("Juan Pérez");
    expect(bundle.text).not.toContain("+5491123456789");
    expect(bundle.json).not.toContain("Juan Pérez");
    expect(bundle.json).not.toContain("5491123456789");
  });
});
