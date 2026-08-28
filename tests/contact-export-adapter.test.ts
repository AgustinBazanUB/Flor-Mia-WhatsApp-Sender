// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  contactExportAdapterSupportsCurrentDocument,
  detectWhatsAppLabels,
  isClearlyNonContactStructuredId
} from "../src/contact-export/whatsapp-contact-adapter";

describe("WhatsApp contact export semantic adapter", () => {
  beforeEach(() => {
    history.replaceState({}, "", "/");
    document.body.innerHTML = "";
  });

  it("detects labels dynamically without hardcoded zone names", async () => {
    document.body.innerHTML = `
      <main>
        <h2>Etiquetas</h2>
        <div role="list">
          <button role="listitem"><span title="Microcentro">Microcentro</span><small>3</small></button>
          <button role="listitem"><span title="Tribunales">Tribunales</span><small>7</small></button>
        </div>
      </main>`;
    const result = await detectWhatsAppLabels();
    expect(result.labels.map((label) => label.name)).toEqual(expect.arrayContaining(["Microcentro", "Tribunales"]));
    expect(result.labels.find((label) => label.name === "Microcentro")?.countHint).toBe(3);
  });

  it("also recognizes WhatsApp accounts where Labels are presented as Lists", async () => {
    document.body.innerHTML = `
      <main>
        <h2>Listas</h2>
        <div role="list">
          <button role="listitem"><span title="Palermo">Palermo</span><small>2</small></button>
        </div>
      </main>`;
    const result = await detectWhatsAppLabels();
    expect(result.labels.map((label) => label.name)).toContain("Palermo");
  });

  it("fails clearly when a labels hub exists but no labels can be read", async () => {
    document.body.innerHTML = `<main><h2>Etiquetas</h2><div role="list"></div></main>`;
    await expect(detectWhatsAppLabels()).rejects.toMatchObject({
      code: "ELEMENT_NOT_FOUND",
      details: expect.objectContaining({ contactExportCode: "LABELS_NOT_FOUND", stage: "detect_labels" })
    });
  });

  it("classifies group, broadcast and newsletter identifiers as non-contact structures", () => {
    expect(isClearlyNonContactStructuredId("120363001234567890@g.us")).toBe(true);
    expect(isClearlyNonContactStructuredId("12345@newsletter")).toBe(true);
    expect(isClearlyNonContactStructuredId("status@broadcast")).toBe(true);
    expect(isClearlyNonContactStructuredId("5491123456789@c.us")).toBe(false);
  });

  it("does not require a focused tab to recognize a WhatsApp document", () => {
    Object.defineProperty(window, "location", { value: new URL("https://web.whatsapp.com/"), configurable: true });
    document.body.innerHTML = `<div id="pane-side"></div>`;
    expect(contactExportAdapterSupportsCurrentDocument()).toBe(true);
  });
});
