// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  candidateFromScopedLabelRow,
  collectScopedLabelRows,
  contactExportAdapterSupportsCurrentDocument,
  detectWhatsAppLabels,
  isClearlyNonContactStructuredId,
  resolveLabelScopedView,
  type LabelScopedView
} from "../src/contact-export/whatsapp-contact-adapter";
import type { WhatsAppLabelInfo } from "../src/contact-export/types";

function label(overrides: Partial<WhatsAppLabelInfo> = {}): WhatsAppLabelInfo {
  return {
    id: "label-tribunales",
    name: "Zona Tribunales",
    countHint: 10,
    countHintStrategy: "dedicated-count",
    sourceId: "label-id-1",
    strategy: "semantic-label-hub+structured-id",
    ...overrides
  };
}

function row(phone: string, name: string, position: number): string {
  return `<div role="listitem" aria-posinset="${position}" data-jid="${phone}@c.us"><span title="${name}">${name}</span></div>`;
}

function setScrollGeometry(element: HTMLElement, values: { clientHeight: number; scrollHeight: number; scrollTop?: number }): void {
  let top = values.scrollTop ?? 0;
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => values.clientHeight });
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => values.scrollHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = value; }
  });
}

describe("WhatsApp contact export semantic adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    history.replaceState({}, "", "/");
    document.body.innerHTML = "";
  });

  it("detects labels dynamically without hardcoded zone names", async () => {
    document.body.innerHTML = `
      <main>
        <h2>Etiquetas</h2>
        <div role="list">
          <button role="listitem" data-label-id="zone-a"><span title="Microcentro">Microcentro</span><small>3</small></button>
          <button role="listitem" data-label-id="zone-b"><span title="Tribunales">Tribunales</span><small>7</small></button>
        </div>
      </main>`;
    const result = await detectWhatsAppLabels();
    expect(result.labels.map((item) => item.name)).toEqual(expect.arrayContaining(["Microcentro", "Tribunales"]));
    expect(result.labels.find((item) => item.name === "Microcentro")).toMatchObject({
      countHint: 3,
      countHintStrategy: "dedicated-count",
      sourceId: "zone-a"
    });
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
    expect(result.labels.map((item) => item.name)).toContain("Palermo");
  });

  it("does not treat an arbitrary number in the label name as an official contact count", async () => {
    document.body.innerHTML = `
      <main><h2>Etiquetas</h2><div role="list">
        <button role="listitem"><span title="Clientes 2026">Clientes 2026</span></button>
      </div></main>`;
    const result = await detectWhatsAppLabels();
    expect(result.labels[0]?.name).toBe("Clientes 2026");
    expect(result.labels[0]?.countHint).toBeNull();
  });

  it("fails clearly when a labels hub exists but no labels can be read", async () => {
    document.body.innerHTML = `<main><h2>Etiquetas</h2><div role="list"></div></main>`;
    await expect(detectWhatsAppLabels()).rejects.toMatchObject({
      code: "ELEMENT_NOT_FOUND",
      details: expect.objectContaining({ contactExportCode: "LABELS_NOT_FOUND", stage: "detect_labels" })
    });
  });

  it("resolves the phone directly from a personal JID without opening a chat", () => {
    document.body.innerHTML = `<div id="row" role="listitem" data-jid="5491123456789@c.us"><span title="Juan Pérez">Juan Pérez</span></div>`;
    const resolved = candidateFromScopedLabelRow(document.getElementById("row")!, label(), 0).candidate;
    expect(resolved).toMatchObject({
      phoneCandidate: "5491123456789@c.us",
      phoneSource: "jid",
      phoneStatus: "resolved",
      name: "Juan Pérez",
      labelName: "Zona Tribunales"
    });
  });

  it("leaves name empty when WhatsApp displays only the phone as title", () => {
    document.body.innerHTML = `<div id="row" role="listitem" data-jid="5491123456789@c.us"><span title="+54 9 11 2345-6789">+54 9 11 2345-6789</span></div>`;
    const resolved = candidateFromScopedLabelRow(document.getElementById("row")!, label(), 0).candidate;
    expect(resolved.phoneStatus).toBe("resolved");
    expect(resolved.name).toBe("");
  });

  it("keeps a foreign structured phone and never adds Argentina", () => {
    document.body.innerHTML = `<div id="row" role="listitem" data-phone="34612345678"><span title="Ana">Ana</span></div>`;
    const resolved = candidateFromScopedLabelRow(document.getElementById("row")!, label(), 0).candidate;
    expect(resolved.phoneCandidate).toBe("34612345678");
    expect(resolved.phoneSource).toBe("structured_phone");
    expect(resolved.phoneStatus).toBe("resolved");
  });

  it("marks an unresolved row instead of opening its chat or inventing a phone", () => {
    document.body.innerHTML = `<div id="row" role="listitem" data-contact-id="opaque-contact"><span title="Cliente guardado">Cliente guardado</span></div>`;
    const element = document.getElementById("row")!;
    const clickSpy = vi.spyOn(element, "click");
    const resolved = candidateFromScopedLabelRow(element, label(), 0).candidate;
    expect(resolved.phoneStatus).toBe("unresolved");
    expect(resolved.phoneCandidate).toBeNull();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("collects ten label-scoped contacts and ignores re-rendered duplicate rows", async () => {
    document.body.innerHTML = `<section id="scope"><h2 id="marker">Zona Tribunales</h2><div id="list" role="list"></div></section>`;
    const scope = document.getElementById("scope")!;
    const list = document.getElementById("list")!;
    const marker = document.getElementById("marker")!;
    list.innerHTML = Array.from({ length: 10 }, (_, index) => row(`54911000000${index}`, `Cliente ${index}`, index + 1)).join("")
      + row("549110000002", "Cliente 2", 3)
      + row("549110000007", "Cliente 7", 8);
    setScrollGeometry(list, { clientHeight: 500, scrollHeight: 500 });
    const view: LabelScopedView = { scopeRoot: scope, listRoot: list, scrollRoot: list, marker, strategy: "test-scoped-list" };
    const result = await collectScopedLabelRows(view, label(), {}, 1, 1);
    expect(result.result.collectedUniqueContacts).toBe(10);
    expect(result.candidates).toHaveLength(10);
    expect(result.result.scrollOperations).toBe(0);
  });

  it("turns the 10 to 56 class of scope leak into a hard error", async () => {
    document.body.innerHTML = `<section id="scope"><h2 id="marker">Zona Tribunales</h2><div id="list" role="list"></div></section>`;
    const scope = document.getElementById("scope")!;
    const list = document.getElementById("list")!;
    const marker = document.getElementById("marker")!;
    list.innerHTML = Array.from({ length: 11 }, (_, index) => row(`54911900000${index}`, `Cliente ${index}`, index + 1)).join("");
    setScrollGeometry(list, { clientHeight: 500, scrollHeight: 500 });
    const view: LabelScopedView = { scopeRoot: scope, listRoot: list, scrollRoot: list, marker, strategy: "test-scoped-list" };
    await expect(collectScopedLabelRows(view, label({ countHint: 10 }), {}, 1, 1)).rejects.toMatchObject({
      details: expect.objectContaining({
        contactExportCode: "EXTRACTION_SCOPE_BROKEN",
        expectedCount: 10,
        collectedCount: 11
      })
    });
  });

  it("allows an empty label to complete with zero contacts", async () => {
    document.body.innerHTML = `<section id="scope"><h2 id="marker">Zona Tribunales</h2><div id="list" role="list"></div></section>`;
    const scope = document.getElementById("scope")!;
    const list = document.getElementById("list")!;
    const marker = document.getElementById("marker")!;
    setScrollGeometry(list, { clientHeight: 500, scrollHeight: 500 });
    const view: LabelScopedView = { scopeRoot: scope, listRoot: list, scrollRoot: list, marker, strategy: "test-scoped-list" };
    const result = await collectScopedLabelRows(view, label({ countHint: 0 }), {}, 1, 1);
    expect(result.candidates).toEqual([]);
    expect(result.result.collectedUniqueContacts).toBe(0);
  });

  it("walks a virtualized label list until all unique positions are collected", async () => {
    document.body.innerHTML = `<section id="scope"><h2 id="marker">Zona Tribunales</h2><div id="list" role="list"></div></section>`;
    const scope = document.getElementById("scope")!;
    const list = document.getElementById("list")!;
    const marker = document.getElementById("marker")!;
    let page = 0;
    const renderPage = () => {
      const start = page * 4;
      list.innerHTML = Array.from({ length: Math.min(4, 10 - start) }, (_, offset) => {
        const index = start + offset;
        return row(`54911800000${index}`, `Cliente ${index}`, index + 1);
      }).join("");
    };
    renderPage();
    setScrollGeometry(list, { clientHeight: 400, scrollHeight: 1200 });
    list.addEventListener("scroll", () => {
      if (page < 2) {
        page += 1;
        renderPage();
      }
    });
    const view: LabelScopedView = { scopeRoot: scope, listRoot: list, scrollRoot: list, marker, strategy: "virtualized-test" };
    const result = await collectScopedLabelRows(view, label({ countHint: 10 }), {}, 1, 1);
    expect(result.result.collectedUniqueContacts).toBe(10);
    expect(result.candidates).toHaveLength(10);
    expect(result.result.scrollOperations).toBeGreaterThan(0);
  });

  it("counts a phone-unresolved row instead of reporting processed 1 but collected 0", async () => {
    document.body.innerHTML = `<section id="scope"><h2 id="marker">Zona Tribunales</h2><div id="list" role="list"><div role="listitem"><span title="Cliente pendiente">Cliente pendiente</span></div></div></section>`;
    const scope = document.getElementById("scope")!;
    const list = document.getElementById("list")!;
    const markerElement = document.getElementById("marker")!;
    setScrollGeometry(list, { clientHeight: 500, scrollHeight: 500 });
    const view: LabelScopedView = { scopeRoot: scope, listRoot: list, scrollRoot: list, marker: markerElement, strategy: "test-scoped-list" };
    const result = await collectScopedLabelRows(view, label({ countHint: 1 }), {}, 1, 1);
    expect(result.result.collectedUniqueContacts).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.phoneStatus).toBe("unresolved");
  });

  it("finds a real outer scroll viewport when the semantic list itself is not scrollable", async () => {
    document.body.innerHTML = `<div id="viewport"><section id="scope"><h2 id="marker">Zona Tribunales</h2><div id="list" role="list"></div></section></div>`;
    const viewport = document.getElementById("viewport")!;
    const scope = document.getElementById("scope")!;
    const list = document.getElementById("list")!;
    const markerElement = document.getElementById("marker")!;
    let page = 0;
    const renderPage = () => {
      list.innerHTML = row(`54911700000${page}`, `Cliente ${page}`, page + 1);
    };
    renderPage();
    setScrollGeometry(list, { clientHeight: 400, scrollHeight: 400 });
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 5000 });
    viewport.addEventListener("scroll", () => {
      if (page < 9) {
        page += 1;
        renderPage();
      }
    });
    const view: LabelScopedView = { scopeRoot: scope, listRoot: list, scrollRoot: list, marker: markerElement, strategy: "real-session-regression" };
    const result = await collectScopedLabelRows(view, label({ countHint: 10 }), {}, 1, 1);
    expect(result.result.collectedUniqueContacts).toBe(10);
    expect(result.candidates).toHaveLength(10);
    expect(result.result.scrollOperations).toBeGreaterThan(0);
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

  it("rejects a one-row nearby semantic list and selects the changed filtered pane for a 10-contact label", () => {
    document.body.innerHTML = `
      <section id="sidebar-shell">
        <div id="marker" aria-selected="true" title="Zona Tribunales">Zona Tribunales</div>
        <div id="nearby-list" role="list">
          <div role="listitem" data-index="0"><span title="Zona Tribunales">Zona Tribunales</span></div>
        </div>
        <div id="pane-side" role="list"></div>
      </section>`;
    const pane = document.getElementById("pane-side")!;
    pane.innerHTML = Array.from({ length: 10 }, (_, index) => row(`54911770000${index}`, `Cliente ${index}`, index + 1)).join("");
    setScrollGeometry(document.getElementById("nearby-list")!, { clientHeight: 80, scrollHeight: 80 });
    setScrollGeometry(pane, { clientHeight: 500, scrollHeight: 500 });

    const view = resolveLabelScopedView(label({ countHint: 10 }), "fingerprint-before-filter");
    expect(view?.listRoot.id).toBe("pane-side");
    expect(view?.strategy).toBe("selected-label-marker+changed-pane");
  });

  it("does not accept a one-row non-scrollable list when the selected label reports ten contacts", () => {
    document.body.innerHTML = `
      <section id="sidebar-shell">
        <div id="marker" aria-selected="true" title="Zona Tribunales">Zona Tribunales</div>
        <div id="nearby-list" role="list">
          <div role="listitem" data-index="0"><span title="Cliente visible">Cliente visible</span></div>
        </div>
      </section>`;
    const nearby = document.getElementById("nearby-list")!;
    setScrollGeometry(nearby, { clientHeight: 80, scrollHeight: 80 });
    expect(resolveLabelScopedView(label({ countHint: 10 }), "missing")).toBeNull();
  });

});
