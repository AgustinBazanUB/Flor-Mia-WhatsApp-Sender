from pathlib import Path

adapter_path = Path('src/contact-export/whatsapp-contact-adapter.ts')
s = adapter_path.read_text(encoding='utf-8')

old = '''function findScrollRoot(listRoot: HTMLElement, scopeRoot: HTMLElement): HTMLElement {
  const candidates: HTMLElement[] = [listRoot];
  let current = listRoot.parentElement;
  while (current && scopeRoot.contains(current)) {
    candidates.push(current);
    if (current === scopeRoot) break;
    current = current.parentElement;
  }
  for (const candidate of candidates) {
    if (candidate.scrollHeight > candidate.clientHeight + 4) return candidate;
    const overflow = globalThis.getComputedStyle?.(candidate)?.overflowY;
    if (overflow === "auto" || overflow === "scroll") return candidate;
  }
  return listRoot;
}'''
new = '''function hasScrollableRange(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight + 4;
}

function declaresScrollableOverflow(element: HTMLElement): boolean {
  const overflow = globalThis.getComputedStyle?.(element)?.overflowY;
  return overflow === "auto" || overflow === "scroll";
}

function findScrollRoot(listRoot: HTMLElement, scopeRoot: HTMLElement): HTMLElement {
  const candidates: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const add = (element: HTMLElement | null): void => {
    if (!element || seen.has(element) || element === document.body) return;
    seen.add(element);
    candidates.push(element);
  };

  add(listRoot);

  // WhatsApp puede renderizar el role=list dentro de un viewport que vive por
  // encima del scope semántico más pequeño. No cortamos en scopeRoot: seguimos
  // pocos ancestros y seguimos validando el marker de etiqueta en cada pasada.
  let current = listRoot.parentElement;
  for (let depth = 0; current && depth < 14; depth += 1, current = current.parentElement) {
    add(current);
    if (current.id === "pane-side") break;
  }

  // Algunas builds colocan un viewport scrollable dentro del role=list.
  for (const descendant of [...listRoot.querySelectorAll<HTMLElement>("div,[role='list'],[role='grid']")].slice(0, 120)) {
    if (!visible(descendant)) continue;
    if (!descendant.querySelector(CONTACT_ROW_SELECTOR)) continue;
    add(descendant);
  }

  return candidates.find(hasScrollableRange)
    ?? candidates.find(declaresScrollableOverflow)
    ?? (hasScrollableRange(scopeRoot) || declaresScrollableOverflow(scopeRoot) ? scopeRoot : listRoot);
}'''
assert old in s, 'findScrollRoot block not found'
s = s.replace(old, new)

old = '''        const scopeRoot = container;
        const scrollRoot = findScrollRoot(listRoot, scopeRoot);
        if (!scopeRoot.contains(scrollRoot)) continue;
        return {'''
new = '''        const scopeRoot = container;
        const scrollRoot = findScrollRoot(listRoot, scopeRoot);
        const scrollRelated = scrollRoot === listRoot || scrollRoot.contains(listRoot) || listRoot.contains(scrollRoot);
        if (!scrollRelated) continue;
        return {'''
assert old in s, 'scrollRoot relation block not found'
s = s.replace(old, new)

old = '''function positionalIdentity(row: HTMLElement): string | null {
  const value = row.getAttribute("aria-posinset") || row.getAttribute("aria-rowindex");
  return value && /^\\d+$/.test(value) ? `position:${value}` : null;
}'''
new = '''function positionalIdentity(row: HTMLElement): string | null {
  const attributes = ["aria-posinset", "aria-rowindex", "data-index", "data-row-index", "data-list-index", "data-item-index"];
  for (const attribute of attributes) {
    const value = row.getAttribute(attribute);
    if (value && /^\\d+$/.test(value)) return `position:${attribute}:${value}`;
  }

  const style = row.getAttribute("style") || "";
  const translateY = style.match(/translateY\\(\\s*(-?\\d+(?:\\.\\d+)?)px\\s*\\)/i)?.[1]
    ?? style.match(/translate3d\\(\\s*[^,]+,\\s*(-?\\d+(?:\\.\\d+)?)px/i)?.[1]
    ?? style.match(/(?:^|;)\\s*top:\\s*(-?\\d+(?:\\.\\d+)?)px/i)?.[1];
  if (translateY != null) return `layout:${Math.round(Number(translateY))}`;
  if (Number.isFinite(row.offsetTop) && row.offsetTop > 0) return `offset:${Math.round(row.offsetTop)}`;
  return null;
}

function anonymousTraversalIdentity(row: HTMLElement, rowIndex: number): string | null {
  const positional = positionalIdentity(row);
  if (positional) return positional;
  const structural = [
    row.id,
    row.getAttribute("data-testid"),
    row.getAttribute("aria-label"),
    row.getAttribute("title"),
    ...[...row.querySelectorAll<HTMLAnchorElement>("a[href]")].slice(0, 8).map((anchor) => anchor.getAttribute("href")),
    ...[...row.querySelectorAll<HTMLElement>("[title],[aria-label]")].slice(0, 20).flatMap((element) => [element.getAttribute("title"), element.getAttribute("aria-label")]),
    textOf(row)
  ].filter((value): value is string => Boolean(value && value.trim())).join("|").replace(/\\s+/g, " ").trim();
  if (!structural) return null;
  // Sólo sirve para recorrido/pendientes. Nunca convierte una fila anónima en
  // contacto válido ni permite inventar un teléfono.
  return `anonymous:${opaqueId(`${structural.slice(0, 1200)}:${rowIndex}`)}`;
}'''
assert old in s, 'positionalIdentity block not found'
s = s.replace(old, new)

old = '''  const position = positionalIdentity(row);
  const stableKey = normalized?.digits ? `phone:${normalized.digits}` : contactId ? `contact:${contactId}` : position;
  const countKey = stableKey ?? null;
  const sourceId = opaqueId(`${label.id}:${stableKey ?? `unresolved-row:${rowIndex}`}`);'''
new = '''  const position = positionalIdentity(row);
  const stableKey = normalized?.digits ? `phone:${normalized.digits}` : contactId ? `contact:${contactId}` : position;
  const countKey = stableKey ?? anonymousTraversalIdentity(row, rowIndex);
  const sourceId = opaqueId(`${label.id}:${stableKey ?? countKey ?? `unresolved-row:${rowIndex}`}`);'''
assert old in s, 'candidate identity block not found'
s = s.replace(old, new)

old = '''function atScrollEnd(root: HTMLElement): boolean {
  if (root.scrollHeight <= root.clientHeight + 4) return true;
  return root.scrollTop + root.clientHeight >= root.scrollHeight - 4;
}'''
new = '''type ScrollState = "more" | "end" | "not-scrollable";

function scrollState(root: HTMLElement): ScrollState {
  if (!hasScrollableRange(root)) return "not-scrollable";
  return root.scrollTop + root.clientHeight >= root.scrollHeight - 4 ? "end" : "more";
}

function scrollDiagnosticDetails(root: HTMLElement, visibleRows: number): Record<string, unknown> {
  return {
    scrollRootId: root.id || null,
    scrollRootRole: root.getAttribute("role"),
    scrollTop: Math.round(root.scrollTop),
    scrollHeight: Math.round(root.scrollHeight),
    clientHeight: Math.round(root.clientHeight),
    scrollState: scrollState(root),
    visibleRows
  };
}'''
assert old in s, 'atScrollEnd block not found'
s = s.replace(old, new)

start = s.index('export async function collectScopedLabelRows(')
end = s.index('\nexport async function collectContactsForLabels(', start)
new_block = '''export async function collectScopedLabelRows(
  view: LabelScopedView,
  label: WhatsAppLabelInfo,
  options: CollectSelectedLabelsOptions,
  labelIndex: number,
  totalLabels: number
): Promise<{ candidates: RawContactCandidate[]; result: ContactExportLabelResult; visualOperations: number }> {
  const collected = new Map<string, RawContactCandidate>();
  const unresolved = new Map<string, RawContactCandidate>();
  const countedRows = new Set<string>();
  let stablePasses = 0;
  let rowScans = 0;
  let scrollOperations = 0;
  let lastUniqueCount = -1;

  for (let pass = 0; pass < 200; pass += 1) {
    abortIfNeeded(options.signal);
    if (!labelScopeStillActive(view, label)) {
      throw new ExtensionError(ERROR_CODES.elementNotFound, "La extracción salió del ámbito de la etiqueta seleccionada.", {
        recoverable: true,
        details: {
          contactExportCode: CONTACT_EXPORT_ERROR_CODES.extractionScopeBroken,
          stage: "label_scoped_contact_extraction",
          labelId: label.id,
          strategy: view.strategy,
          expectedCount: label.countHint,
          collectedCount: countedRows.size
        }
      });
    }

    view.scrollRoot = findScrollRoot(view.listRoot, view.scopeRoot);
    const rows = rowsFromScopedList(view.listRoot);
    rows.forEach((row, index) => {
      rowScans += 1;
      const resolved = candidateFromScopedLabelRow(row, label, index);
      if (resolved.countKey) countedRows.add(resolved.countKey);
      if (resolved.stableKey) {
        if (!collected.has(resolved.stableKey)) collected.set(resolved.stableKey, resolved.candidate);
      } else {
        const problemKey = resolved.countKey ?? `visible-slot:${index}`;
        if (!unresolved.has(problemKey)) unresolved.set(problemKey, resolved.candidate);
      }
    });

    const uniqueCount = countedRows.size;
    if (label.countHint != null && uniqueCount > label.countHint) {
      throw new ExtensionError(ERROR_CODES.elementNotFound, "La extracción obtuvo más elementos que la cantidad informada por la etiqueta. Se detuvo para evitar incluir chats externos.", {
        recoverable: false,
        details: {
          contactExportCode: CONTACT_EXPORT_ERROR_CODES.extractionScopeBroken,
          stage: "label_scoped_contact_extraction",
          labelId: label.id,
          strategy: view.strategy,
          expectedCount: label.countHint,
          collectedCount: uniqueCount,
          ...scrollDiagnosticDetails(view.scrollRoot, rows.length)
        }
      });
    }

    const candidatesNow = [...collected.values(), ...unresolved.values()];
    const resolvedPhonesNow = candidatesNow.filter((candidate) => candidate.phoneStatus === "resolved").length;
    const unresolvedPhonesNow = candidatesNow.filter((candidate) => candidate.phoneStatus !== "resolved" && (candidate.kind === "contact" || candidate.kind === "unknown")).length;
    const processed = candidatesNow.length;
    const percent = label.countHint != null && label.countHint > 0
      ? Math.min(100, Math.round((uniqueCount / label.countHint) * 100))
      : null;
    await options.progress?.({
      processed,
      totalHint: label.countHint,
      percent,
      currentLabel: label.name,
      labelIndex,
      totalLabels,
      currentContact: processed,
      labelResults: [{
        labelId: label.id,
        labelName: label.name,
        reportedCount: label.countHint,
        collectedUniqueContacts: uniqueCount,
        resolvedPhones: resolvedPhonesNow,
        unresolvedPhones: unresolvedPhonesNow,
        rowScans,
        scrollOperations,
        scopeStrategy: view.strategy
      }]
    });

    if (label.countHint != null && uniqueCount >= label.countHint) break;

    const state = scrollState(view.scrollRoot);
    if (uniqueCount === lastUniqueCount) stablePasses += 1;
    else stablePasses = 0;
    lastUniqueCount = uniqueCount;

    if (state === "end" && stablePasses >= 2) {
      if (label.countHint == null) break;
      throw new ExtensionError(ERROR_CODES.elementNotFound, "La lista llegó a su final visible antes de alcanzar la cantidad informada por la etiqueta.", {
        recoverable: true,
        details: {
          contactExportCode: CONTACT_EXPORT_ERROR_CODES.labelContactCountMismatch,
          stage: "validate_label_count",
          labelId: label.id,
          strategy: view.strategy,
          expectedCount: label.countHint,
          collectedCount: uniqueCount,
          ...scrollDiagnosticDetails(view.scrollRoot, rows.length)
        }
      });
    }

    if (state === "not-scrollable" && label.countHint != null && uniqueCount < label.countHint && stablePasses >= 4) {
      throw new ExtensionError(ERROR_CODES.interfaceLoading, "WhatsApp informa más contactos, pero todavía no se pudo identificar un viewport que permita continuar recorriendo la lista.", {
        recoverable: true,
        details: {
          contactExportCode: CONTACT_EXPORT_ERROR_CODES.virtualListStalled,
          stage: "virtual_list_scroll_root",
          labelId: label.id,
          strategy: view.strategy,
          expectedCount: label.countHint,
          collectedCount: uniqueCount,
          ...scrollDiagnosticDetails(view.scrollRoot, rows.length)
        }
      });
    }

    if (state === "more" && stablePasses >= 5) {
      throw new ExtensionError(ERROR_CODES.interfaceLoading, "La lista virtualizada dejó de entregar contactos nuevos antes de llegar al final.", {
        recoverable: true,
        details: {
          contactExportCode: CONTACT_EXPORT_ERROR_CODES.virtualListStalled,
          stage: "virtual_list_scroll",
          labelId: label.id,
          strategy: view.strategy,
          expectedCount: label.countHint,
          collectedCount: uniqueCount,
          ...scrollDiagnosticDetails(view.scrollRoot, rows.length)
        }
      });
    }

    if (state === "more") {
      const before = view.scrollRoot.scrollTop;
      const step = Math.max(view.scrollRoot.clientHeight * 0.85, 420);
      view.scrollRoot.scrollTop = Math.min(view.scrollRoot.scrollHeight, before + step);
      view.scrollRoot.dispatchEvent(new Event("scroll", { bubbles: true }));
      if (view.scrollRoot.scrollTop !== before) scrollOperations += 1;
    } else if (state === "not-scrollable") {
      const lastRow = rows.at(-1);
      try {
        lastRow?.scrollIntoView?.({ block: "end", inline: "nearest" });
      } catch {
        // Algunos DOM de test/builds viejos no ofrecen scrollIntoView.
      }
      view.listRoot.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }

  if (label.countHint != null && countedRows.size !== label.countHint) {
    throw new ExtensionError(ERROR_CODES.interfaceLoading, "No se alcanzó la cantidad informada por la etiqueta antes del límite de recorrido.", {
      recoverable: true,
      details: {
        contactExportCode: CONTACT_EXPORT_ERROR_CODES.virtualListStalled,
        stage: "virtual_list_iteration_limit",
        labelId: label.id,
        strategy: view.strategy,
        expectedCount: label.countHint,
        collectedCount: countedRows.size,
        ...scrollDiagnosticDetails(view.scrollRoot, rowsFromScopedList(view.listRoot).length)
      }
    });
  }

  const candidates = [...collected.values(), ...unresolved.values()];
  const resolvedPhones = candidates.filter((candidate) => candidate.phoneStatus === "resolved").length;
  const unresolvedPhones = candidates.filter((candidate) => candidate.phoneStatus !== "resolved" && (candidate.kind === "contact" || candidate.kind === "unknown")).length;
  return {
    candidates,
    visualOperations: scrollOperations,
    result: {
      labelId: label.id,
      labelName: label.name,
      reportedCount: label.countHint,
      collectedUniqueContacts: countedRows.size || candidates.length,
      resolvedPhones,
      unresolvedPhones,
      rowScans,
      scrollOperations,
      scopeStrategy: view.strategy
    }
  };
}
'''
s = s[:start] + new_block + s[end:]
adapter_path.write_text(s, encoding='utf-8')

release_test = Path('tests/release-metadata.test.ts')
rt = release_test.read_text(encoding='utf-8')
rt = rt.replace(r'/^\d+\.\d+\.\d+\.\d+$/', r'/^\d+\.\d+\.\d+(?:\.\d+)?$/')
release_test.write_text(rt, encoding='utf-8')

test_path = Path('tests/contact-export-adapter.test.ts')
t = test_path.read_text(encoding='utf-8')
marker = '  it("classifies group, broadcast and newsletter identifiers as non-contact structures", () => {'
assert marker in t, 'adapter test insertion point not found'
extra = r'''  it("counts a phone-unresolved row instead of reporting processed 1 but collected 0", async () => {
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

'''
t = t.replace(marker, extra + marker)
test_path.write_text(t, encoding='utf-8')

docs_path = Path('docs/contact-export-release-notes-9.5.1.md')
d = docs_path.read_text(encoding='utf-8')
note = '''\n## Hotfix de validación con sesión real — 2026-08-29\n\nUn reporte real de `Falta Enviar` mostró `Reported contacts: 10`, `Processed count: 1` y `Collected unique contacts: 0`. La causa era doble: el role=list podía no ser el viewport scrollable real y una fila sin JID/teléfono/posición se procesaba como pendiente sin entrar al contador de recorrido.\n\n9.5.1 ahora reevalúa el scroll root por ancestros/viewport, no interpreta un nodo no-scrollable como final de lista, mantiene identidad anónima sólo para recorrido de pendientes (sin convertirla en teléfono válido) y publica resultados parciales para que el diagnóstico conserve `collectedUniqueContacts` aunque la extracción falle.\n'''
if '## Hotfix de validación con sesión real' not in d:
    d += note
docs_path.write_text(d, encoding='utf-8')
