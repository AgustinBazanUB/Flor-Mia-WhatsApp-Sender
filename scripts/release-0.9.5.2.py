from pathlib import Path
import json

ROOT = Path('.')

# --- WhatsApp label scope selection / virtual list traversal -----------------
adapter_path = ROOT / 'src/contact-export/whatsapp-contact-adapter.ts'
s = adapter_path.read_text(encoding='utf-8')

start = s.index('function resolveLabelScopedView(')
end = s.index('\nasync function openLabelScopedView(', start)
replacement = r'''interface LabelListCandidateEvaluation {
  view: LabelScopedView;
  score: number;
  eligible: boolean;
  reason: string;
  visibleRows: number;
  scrollable: boolean;
  paneChanged: boolean;
  evidenceScore: number;
}

function shortDomIdentity(element: HTMLElement): string {
  const id = element.id ? `#${element.id}` : '';
  const role = element.getAttribute('role');
  return `${element.tagName.toLowerCase()}${id}${role ? `[role=${role}]` : ''}`;
}

function contactEvidenceScore(rows: HTMLElement[]): number {
  let score = 0;
  for (const row of rows.slice(0, 24)) {
    const values = candidateStructuredValues(row);
    const kind = kindFromValues(values);
    if (kind === 'contact') score += 6;
    else if (kind !== 'unknown') score -= 4;
    if (values.some((value) => /@lid/i.test(value))) score += 2;
    if (STRUCTURED_PHONE_ATTRIBUTES.some((attribute) => Boolean(row.getAttribute(attribute) || row.querySelector(`[${attribute}]`)))) score += 4;
    if (row.querySelector("a[href^='tel:'],a[href*='phone='],a[href*='wa.me']")) score += 4;
    if (textOf(row)) score += 1;
  }
  return score;
}

function evaluateLabelListCandidate(
  listRoot: HTMLElement,
  scopeRoot: HTMLElement,
  marker: HTMLElement,
  label: WhatsAppLabelInfo,
  beforePaneFingerprint: string
): LabelListCandidateEvaluation {
  const rows = rowsFromScopedList(listRoot);
  const markerInsideList = listRoot.contains(marker);
  const paneCandidate = listRoot.id === 'pane-side';
  const paneChanged = paneCandidate && listFingerprint(listRoot) !== beforePaneFingerprint;
  const genericLabelsHub = markerInsideList && scopeContainsGenericLabelsHub(scopeRoot);
  const scrollRoot = findScrollRoot(listRoot, scopeRoot);
  const scrollRelated = scrollRoot === listRoot || scrollRoot.contains(listRoot) || listRoot.contains(scrollRoot);
  const scrollable = hasScrollableRange(scrollRoot) || declaresScrollableOverflow(scrollRoot);
  const expected = label.countHint;
  const canReachExpected = expected == null || expected === 0 || rows.length >= expected || scrollable;
  const grosslyOverExpected = expected != null && expected > 0 && rows.length > Math.max(expected * 2, expected + 12);
  const paneProven = !paneCandidate || paneChanged || markerInsideList;
  const evidenceScore = contactEvidenceScore(rows);

  let reason = 'eligible';
  if (!scrollRelated) reason = 'scroll-not-related';
  else if (genericLabelsHub) reason = 'generic-label-hub';
  else if (rows.length === 0 && expected !== 0) reason = 'no-contact-rows';
  else if (!canReachExpected) reason = 'cannot-reach-reported-count';
  else if (grosslyOverExpected) reason = 'grossly-over-reported-count';
  else if (!paneProven) reason = 'pane-not-proven-filtered';

  const eligible = reason === 'eligible';
  let score = 0;
  if (eligible) {
    if (paneChanged) score += 1000;
    if (markerInsideList) score += 120;
    if (scrollable) score += 180;
    if (expected != null && rows.length === expected) score += 600;
    if (expected != null && rows.length > 0 && rows.length < expected) score += 80;
    score += Math.min(rows.length, 40) * 15;
    score += evidenceScore * 20;
  }

  return {
    view: {
      scopeRoot,
      listRoot,
      scrollRoot,
      marker,
      strategy: paneChanged
        ? 'selected-label-marker+changed-pane'
        : 'selected-label-marker+ranked-scoped-list'
    },
    score,
    eligible,
    reason,
    visibleRows: rows.length,
    scrollable,
    paneChanged,
    evidenceScore
  };
}

function inspectLabelScopedCandidates(label: WhatsAppLabelInfo, beforePaneFingerprint: string): LabelListCandidateEvaluation[] {
  const markers = activeLabelMarkers(label);
  const contexts = new Map<HTMLElement, { scopeRoot: HTMLElement; marker: HTMLElement }>();

  for (const marker of markers) {
    let container: HTMLElement | null = marker;
    for (let depth = 0; container && depth < 12; depth += 1, container = container.parentElement) {
      if (container === document.body) break;
      for (const listRoot of listCandidatesWithin(container)) {
        if (listRoot.closest('#main')) continue;
        if (!contexts.has(listRoot)) contexts.set(listRoot, { scopeRoot: container, marker });
      }
    }
  }

  const pane = document.querySelector<HTMLElement>('#pane-side');
  const firstMarker = markers[0];
  if (pane && visible(pane) && firstMarker && !contexts.has(pane)) {
    contexts.set(pane, { scopeRoot: pane.parentElement ?? pane, marker: firstMarker });
  }

  return [...contexts.entries()].map(([listRoot, context]) =>
    evaluateLabelListCandidate(listRoot, context.scopeRoot, context.marker, label, beforePaneFingerprint)
  );
}

export function resolveLabelScopedView(label: WhatsAppLabelInfo, beforePaneFingerprint: string): LabelScopedView | null {
  const evaluations = inspectLabelScopedCandidates(label, beforePaneFingerprint)
    .filter((candidate) => candidate.eligible)
    .sort((left, right) => right.score - left.score);
  return evaluations[0]?.view ?? null;
}

function summarizeLabelScopeCandidates(label: WhatsAppLabelInfo, beforePaneFingerprint: string): { count: number; summary: string } {
  const evaluations = inspectLabelScopedCandidates(label, beforePaneFingerprint);
  const summary = evaluations.slice(0, 8).map((candidate) => [
    shortDomIdentity(candidate.view.listRoot),
    `rows=${candidate.visibleRows}`,
    `scroll=${candidate.scrollable ? 'yes' : 'no'}`,
    `paneChanged=${candidate.paneChanged ? 'yes' : 'no'}`,
    `evidence=${candidate.evidenceScore}`,
    `eligible=${candidate.eligible ? 'yes' : 'no'}`,
    `reason=${candidate.reason}`,
    `score=${candidate.score}`
  ].join(' ')).join(' | ');
  return { count: evaluations.length, summary };
}
'''
s = s[:start] + replacement + s[end:]

old = '''  } catch (error) {
    throw new ExtensionError(ERROR_CODES.elementNotFound, "WhatsApp abrió la etiqueta, pero no se pudo demostrar cuál es su listado específico. Se canceló para no leer chats externos.", {
      recoverable: true,
      cause: error,
      details: {
        contactExportCode: CONTACT_EXPORT_ERROR_CODES.labelContainerNotFound,
        stage: "resolve_label_scope",
        labelId: label.id,
        strategy: "selected-label-marker+scoped-list",
        candidateCount: activeLabelMarkers(label).length
      }
    });
  }
}'''
new = '''  } catch (error) {
    const inspected = summarizeLabelScopeCandidates(label, beforePaneFingerprint);
    throw new ExtensionError(ERROR_CODES.elementNotFound, "WhatsApp abrió la etiqueta, pero no se pudo demostrar cuál es su listado específico. Se canceló para no leer chats externos.", {
      recoverable: true,
      cause: error,
      details: {
        contactExportCode: CONTACT_EXPORT_ERROR_CODES.labelContainerNotFound,
        stage: "resolve_label_scope",
        labelId: label.id,
        strategy: "selected-label-marker+ranked-scope",
        candidateCount: inspected.count,
        scopeCandidateCount: inspected.count,
        scopeCandidateSummary: inspected.summary,
        beforePaneFingerprintPresent: beforePaneFingerprint !== "missing"
      }
    });
  }
}'''
assert old in s, 'openLabelScopedView catch block not found'
s = s.replace(old, new)

old = '''    if (state === "end" && stablePasses >= 2) {
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

    if (state === "not-scrollable" && label.countHint != null && uniqueCount < label.countHint && stablePasses >= 4) {'''
new = '''    if (state === "end" && label.countHint == null && stablePasses >= 2) break;
    if (state === "end" && label.countHint != null && uniqueCount < label.countHint && stablePasses >= 6) {
      throw new ExtensionError(ERROR_CODES.elementNotFound, "La lista llegó a su final visible antes de alcanzar la cantidad informada por la etiqueta.", {
        recoverable: true,
        details: {
          contactExportCode: CONTACT_EXPORT_ERROR_CODES.labelContactCountMismatch,
          stage: "validate_label_count",
          labelId: label.id,
          strategy: view.strategy,
          expectedCount: label.countHint,
          collectedCount: uniqueCount,
          scopeCandidateCount: 1,
          scopeCandidateSummary: `${shortDomIdentity(view.listRoot)} rows=${rows.length} scroll=${hasScrollableRange(view.scrollRoot) || declaresScrollableOverflow(view.scrollRoot) ? "yes" : "no"}`,
          ...scrollDiagnosticDetails(view.scrollRoot, rows.length)
        }
      });
    }

    if (state === "not-scrollable" && label.countHint != null && uniqueCount < label.countHint && stablePasses >= 6) {'''
assert old in s, 'end/not-scrollable threshold block not found'
s = s.replace(old, new)

old = '''    if (state === "more") {
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
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));'''
new = '''    if (state === "more") {
      const before = view.scrollRoot.scrollTop;
      const step = Math.max(view.scrollRoot.clientHeight * 0.85, 420);
      view.scrollRoot.scrollTop = Math.min(view.scrollRoot.scrollHeight, before + step);
      view.scrollRoot.dispatchEvent(new Event("scroll", { bubbles: true }));
      if (view.scrollRoot.scrollTop !== before) scrollOperations += 1;
    } else if (state === "not-scrollable" || (state === "end" && label.countHint != null && uniqueCount < label.countHint)) {
      const lastRow = rows.at(-1);
      try {
        lastRow?.scrollIntoView?.({ block: "end", inline: "nearest" });
      } catch {
        // Algunos DOM de test/builds viejos no ofrecen scrollIntoView.
      }
      view.scrollRoot.dispatchEvent(new Event("scroll", { bubbles: true }));
      view.listRoot.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 160));'''
assert old in s, 'scroll action block not found'
s = s.replace(old, new)
adapter_path.write_text(s, encoding='utf-8')

# --- Diagnostic context ------------------------------------------------------
types_path = ROOT / 'src/contact-export/types.ts'
t = types_path.read_text(encoding='utf-8')
t = t.replace('  stack: string | null;\n  updatedAt: string;\n}', '  stack: string | null;\n  technicalDetails: Record<string, string | number | boolean | null>;\n  updatedAt: string;\n}')
types_path.write_text(t, encoding='utf-8')

store_path = ROOT / 'src/contact-export/contact-export-store.ts'
st = store_path.read_text(encoding='utf-8')
st = st.replace('      stack: null,\n      updatedAt: now.toISOString()', '      stack: null,\n      technicalDetails: {},\n      updatedAt: now.toISOString()')
store_path.write_text(st, encoding='utf-8')

dedupe_path = ROOT / 'src/contact-export/contact-deduplicator.ts'
d = dedupe_path.read_text(encoding='utf-8')
d = d.replace('    stack: null,\n    updatedAt: new Date().toISOString()', '    stack: null,\n    technicalDetails: {},\n    updatedAt: new Date().toISOString()')
dedupe_path.write_text(d, encoding='utf-8')

runtime_path = ROOT / 'src/background/contact-export-runtime.ts'
r = runtime_path.read_text(encoding='utf-8')
# Clear old technical context on new operations.
r = r.replace('        stack: null,\n        updatedAt: new Date().toISOString()', '        stack: null,\n        technicalDetails: {},\n        updatedAt: new Date().toISOString()')

insert_at = r.index('\nexport class ContactExportRuntime')
helper = r'''

const CONTACT_EXPORT_TECHNICAL_DETAIL_KEYS = [
  "scopeCandidateCount",
  "scopeCandidateSummary",
  "beforePaneFingerprintPresent",
  "scrollRootId",
  "scrollRootRole",
  "scrollTop",
  "scrollHeight",
  "clientHeight",
  "scrollState",
  "visibleRows",
  "expectedCount",
  "collectedCount",
  "candidateCount"
] as const;

function safeTechnicalDetails(details: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  if (!details) return {};
  const output: Record<string, string | number | boolean | null> = {};
  for (const key of CONTACT_EXPORT_TECHNICAL_DETAIL_KEYS) {
    const value = details[key];
    if (value == null) output[key] = null;
    else if (typeof value === "number" || typeof value === "boolean") output[key] = value;
    else if (typeof value === "string") output[key] = value.slice(0, 1200);
  }
  return output;
}
'''
r = r[:insert_at] + helper + r[insert_at:]
old = '''        errorCode: recognized,
        errorMessage: serialized.message,
        stack: serialized.stack ?? null,
        updatedAt: new Date().toISOString()'''
new = '''        errorCode: recognized,
        errorMessage: serialized.message,
        stack: serialized.stack ?? null,
        technicalDetails: safeTechnicalDetails(serialized.details),
        updatedAt: new Date().toISOString()'''
assert old in r, 'runtime failure diagnostic block not found'
r = r.replace(old, new)
runtime_path.write_text(r, encoding='utf-8')

diag_path = ROOT / 'src/contact-export/contact-export-diagnostics.ts'
diag = diag_path.read_text(encoding='utf-8')
diag = diag.replace('      stack: sanitizeStackTrace(diagnostic.stack),\n      summary: state.summary,', '      stack: sanitizeStackTrace(diagnostic.stack),\n      technicalDetails: diagnostic.technicalDetails,\n      summary: state.summary,')
diag = diag.replace('    `Stack: ${valueOrDash(sanitizeStackTrace(diagnostic.stack))}`,\n    "",', '    `Stack: ${valueOrDash(sanitizeStackTrace(diagnostic.stack))}`,\n    `Technical details: ${Object.keys(diagnostic.technicalDetails).length ? JSON.stringify(diagnostic.technicalDetails) : "—"}`,\n    "",')
diag_path.write_text(diag, encoding='utf-8')

# Console logger: expose the feature-specific code/stage rather than only ELEMENT_NOT_FOUND.
content_path = ROOT / 'src/content/whatsapp.ts'
c = content_path.read_text(encoding='utf-8')
old = '''      const serialized = serializeError(error);
      logger.error("whatsapp.action_failed", { type: message.type, errorCode: serialized.code });
      sendResponse({ ok: false, requestId: message.requestId, error: serialized });'''
new = '''      const serialized = serializeError(error);
      const contactExportCode = typeof serialized.details?.contactExportCode === "string" ? serialized.details.contactExportCode : null;
      const stage = typeof serialized.details?.stage === "string" ? serialized.details.stage : null;
      logger.error("whatsapp.action_failed", {
        type: message.type,
        errorCode: contactExportCode ?? serialized.code,
        transportErrorCode: serialized.code,
        ...(stage ? { stage } : {})
      });
      sendResponse({ ok: false, requestId: message.requestId, error: serialized });'''
assert old in c, 'whatsapp action_failed logger block not found'
c = c.replace(old, new)
content_path.write_text(c, encoding='utf-8')

# --- Tests ------------------------------------------------------------------
adapter_test_path = ROOT / 'tests/contact-export-adapter.test.ts'
at = adapter_test_path.read_text(encoding='utf-8')
at = at.replace('  isClearlyNonContactStructuredId,\n  type LabelScopedView', '  isClearlyNonContactStructuredId,\n  resolveLabelScopedView,\n  type LabelScopedView')
insert = r'''

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
'''
idx = at.rfind('\n});')
assert idx > 0, 'adapter test suite ending not found'
at = at[:idx] + insert + at[idx:]
adapter_test_path.write_text(at, encoding='utf-8')

diag_test_path = ROOT / 'tests/contact-export-diagnostics.test.ts'
dt = diag_test_path.read_text(encoding='utf-8')
dt = dt.replace('      stack: "Error: scope mismatch",\n      updatedAt:', '      stack: "Error: scope mismatch",\n      technicalDetails: { scopeCandidateCount: 2, visibleRows: 1, scrollState: "end", scopeCandidateSummary: "div[role=list] rows=1 scroll=no" },\n      updatedAt:')
dt = dt.replace('    const bundle = createContactExportDiagnosticBundle(state, "9.5.1",', '    const bundle = createContactExportDiagnosticBundle(state, "0.9.5.2",')
dt = dt.replace('    expect(bundle.text).toContain("Chats abiertos durante extracción normal: 0");', '    expect(bundle.text).toContain("Chats abiertos durante extracción normal: 0");\n    expect(bundle.text).toContain("scopeCandidateCount");\n    expect(bundle.json).toContain("visibleRows");')
diag_test_path.write_text(dt, encoding='utf-8')

# --- Version 0.9.5.2 --------------------------------------------------------
manifest_path = ROOT / 'manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['version'] = '0.9.5.2'
manifest['version_name'] = '0.9.5.2'
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

package_path = ROOT / 'package.json'
package = json.loads(package_path.read_text(encoding='utf-8'))
package['version'] = '0.9.5.2'
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

lock_path = ROOT / 'package-lock.json'
lock = json.loads(lock_path.read_text(encoding='utf-8'))
lock['version'] = '0.9.5.2'
if '' in lock.get('packages', {}):
    lock['packages']['']['version'] = '0.9.5.2'
lock_path.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

validate_path = ROOT / 'scripts/validate-build.mjs'
v = validate_path.read_text(encoding='utf-8')
v = v.replace('sourceManifest.version !== "9.5.1"', 'sourceManifest.version !== "0.9.5.2"')
v = v.replace('diagnóstico 9.5.1', 'diagnóstico 0.9.5.2')
v = v.replace('estrategia 9.5.1', 'estrategia 0.9.5.2')
validate_path.write_text(v, encoding='utf-8')

# README version / current notes.
readme_path = ROOT / 'README.md'
readme = readme_path.read_text(encoding='utf-8')
readme = readme.replace('## Contactos de WhatsApp — 9.5.1', '## Contactos de WhatsApp — 0.9.5.2')
readme = readme.replace('La versión 9.5.1 reemplaza', 'La versión 0.9.5.2 mantiene')
readme = readme.replace('[`docs/contact-export-release-notes-9.5.1.md`](docs/contact-export-release-notes-9.5.1.md)', '[`docs/contact-export-release-notes-0.9.5.2.md`](docs/contact-export-release-notes-0.9.5.2.md)')
readme = readme.replace('Contact Export 9.5.1 deliberadamente', 'Contact Export 0.9.5.2 deliberadamente')
readme_path.write_text(readme, encoding='utf-8')

notes = '''# Contact Export 0.9.5.2\n\n## Motivo\n\nUna prueba real con la etiqueta **Falta Enviar** informó 10 contactos, pero 9.5.1 seleccionó un `role=list` semánticamente cercano que sólo exponía una fila. El extractor llegó a `validate_label_count` con `collectedUniqueContacts=1`, `rowScans=3` y `scrollOperations=0`.\n\n## Corrección\n\n- Los posibles listados de una etiqueta se evalúan y puntúan antes de elegir uno.\n- Un listado no scrollable con menos filas que el contador informado ya no puede aceptarse como scope válido.\n- Se prioriza `#pane-side` sólo cuando existe evidencia de que cambió después de seleccionar la etiqueta.\n- La extracción espera más ciclos y fuerza un último nudge de renderizado antes de declarar fin prematuro.\n- Los reportes incorporan datos técnicos no privados del viewport/listado elegido: cantidad de candidatos DOM, filas visibles, estado y geometría de scroll.\n- `whatsapp.action_failed` informa el código específico de Contact Export y la etapa, manteniendo separado el código base de transporte.\n\n## Privacidad\n\nLos nuevos datos de diagnóstico son únicamente estructurales. No incluyen nombres de contactos, teléfonos, mensajes, cookies ni tokens.\n\n## Compatibilidad\n\nEl sender de campañas, texto, imágenes, pausa/reanudación, reconciliación y XLSX no cambia su contrato.\n'''
(ROOT / 'docs/contact-export-release-notes-0.9.5.2.md').write_text(notes, encoding='utf-8')

print('Applied Contact Export 0.9.5.2 real-session scope fix')
