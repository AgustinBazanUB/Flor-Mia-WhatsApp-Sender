import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { waitForCondition } from "../whatsapp/wait";
import {
  normalizeExportPhoneCandidate,
  normalizeStructuredPhone,
  normalizeVisibleInternationalPhone,
  normalizeWhatsAppJidPhone
} from "./phone-normalizer";
import {
  CONTACT_EXPORT_ERROR_CODES,
  type ContactExportLabelResult,
  type ContactExportMetrics,
  type ContactExportProgress,
  type ContactKind,
  type ContactPhoneSource,
  type RawContactCandidate,
  type WhatsAppLabelInfo
} from "./types";

const UI_WORDS = {
  labels: ["etiquetas", "etiqueta", "labels", "label", "listas", "lista", "lists", "list"],
  tools: ["herramientas para la empresa", "herramientas comerciales", "business tools", "tools"],
  more: ["menu", "menú", "mas opciones", "más opciones", "more options", "more"],
  close: ["cerrar", "close"],
  system: ["nueva etiqueta", "new label", "nueva lista", "new list", "crear lista", "create list", "administrar", "manage", "editar", "edit"]
} as const;

const PERSONAL_JID = /\d{8,15}@(c\.us|s\.whatsapp\.net)/i;
const NON_CONTACT_JID = /@(g\.us|broadcast|newsletter)|status@broadcast|community/i;
const STRUCTURED_ID_ATTRIBUTES = ["data-jid", "data-chat-id", "data-peer-id", "data-contact-id", "data-id"] as const;
const STRUCTURED_PHONE_ATTRIBUTES = ["data-phone", "data-phone-number", "data-number", "data-tel"] as const;
const INTERACTIVE_SELECTOR = "button,[role='button'],[role='menuitem'],[role='listitem'],[role='option'],[tabindex='0']";
const LABEL_ROW_SELECTOR = "[role='listitem'],[role='option'],button,[role='button']";
const CONTACT_ROW_SELECTOR = "[role='row'],div[role='listitem'],div[role='option'],[data-testid*='cell'],[data-testid*='chat']";
const LIST_SELECTOR = "[role='grid'],[role='list'],[data-testid*='list'],[data-testid*='chat-list']";
const ACTIVE_LABEL_MARKER_SELECTOR = "h1,h2,h3,[role='heading'],[aria-current='true'],[aria-selected='true'],[data-state='active'],[title],[aria-label]";

export interface ContactExportAdapterProgress {
  (progress: Omit<ContactExportProgress, "operationId" | "updatedAt">): void | Promise<void>;
}

export interface CollectSelectedLabelsOptions {
  signal?: AbortSignal;
  progress?: ContactExportAdapterProgress;
}

export interface ContactExportCollection {
  candidates: RawContactCandidate[];
  strategy: string;
  labelResults: ContactExportLabelResult[];
  metrics: ContactExportMetrics;
}

export interface LabelScopedView {
  scopeRoot: HTMLElement;
  listRoot: HTMLElement;
  scrollRoot: HTMLElement;
  marker: HTMLElement;
  strategy: string;
}

interface RowResolution {
  candidate: RawContactCandidate;
  stableKey: string | null;
  countKey: string | null;
}

function normalizedText(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es");
}

function textOf(element: Element | null | undefined): string {
  if (!element) return "";
  const html = element as HTMLElement;
  return String(html.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
}

function semanticText(element: Element): string {
  return [element.getAttribute("aria-label"), element.getAttribute("title"), textOf(element)].filter(Boolean).join(" ");
}

function matchesAny(value: string, aliases: readonly string[]): boolean {
  const normalized = normalizedText(value);
  return aliases.some((alias) => normalized === normalizedText(alias) || normalized.startsWith(`${normalizedText(alias)} `));
}

function visible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  const style = globalThis.getComputedStyle?.(element);
  return style?.display !== "none" && style?.visibility !== "hidden" && !element.hasAttribute("hidden");
}

function findInteractiveByAliases(root: ParentNode, aliases: readonly string[]): HTMLElement | null {
  const candidates = [...root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)].filter(visible);
  return candidates.find((candidate) => matchesAny(candidate.getAttribute("aria-label") || "", aliases))
    ?? candidates.find((candidate) => matchesAny(candidate.getAttribute("title") || "", aliases))
    ?? candidates.find((candidate) => matchesAny(textOf(candidate), aliases))
    ?? null;
}

function click(element: HTMLElement, onVisualOperation?: () => void): void {
  onVisualOperation?.();
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  element.click();
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operación cancelada", "AbortError");
}

function opaqueId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `wa_${hash.toString(36).padStart(7, "0")}`;
}

function candidateStructuredValues(element: Element): string[] {
  const values = new Set<string>();
  const descendants = [...element.querySelectorAll<HTMLElement>("[data-jid],[data-chat-id],[data-peer-id],[data-contact-id],[data-id]")].slice(0, 40);
  for (const node of [element, ...descendants]) {
    for (const attribute of STRUCTURED_ID_ATTRIBUTES) {
      const value = node.getAttribute(attribute)?.trim();
      if (value) values.add(value);
    }
  }
  return [...values];
}

function kindFromValues(values: string[]): ContactKind {
  const joined = values.join(" ");
  if (/status@broadcast/i.test(joined)) return "status";
  if (/@newsletter/i.test(joined)) return "channel";
  if (/community/i.test(joined)) return "community";
  if (/@g\.us/i.test(joined)) return "group";
  if (/@broadcast/i.test(joined)) return "system";
  if (PERSONAL_JID.test(joined) || /@lid/i.test(joined)) return "contact";
  return "unknown";
}

function labelNameFromRow(row: Element): string {
  const title = row.querySelector<HTMLElement>("[title]")?.getAttribute("title")?.trim();
  if (title && title.length <= 80) return title;
  const text = textOf(row);
  if (!text) return "";
  return text.replace(/\s+\d{1,6}(?:\s+(?:chats?|contactos?|contacts?|elementos?|items?))?\s*$/i, "").trim().slice(0, 80);
}

function explicitLabelCount(row: Element): { count: number | null; strategy: string | null } {
  const labelled = [...row.querySelectorAll<HTMLElement>("[aria-label]")]
    .map((element) => element.getAttribute("aria-label") || "")
    .map((value) => value.match(/\b(\d{1,6})\s+(?:chats?|contactos?|contacts?|elementos?|items?)\b/i)?.[1] ?? null)
    .find(Boolean);
  if (labelled) return { count: Number(labelled), strategy: "aria-count" };

  const dedicated = [...row.querySelectorAll<HTMLElement>("small,[data-count],[data-testid*='count'],[class*='count']")]
    .map((element) => (element.getAttribute("data-count") || textOf(element)).trim())
    .find((value) => /^\d{1,6}$/.test(value));
  if (dedicated) return { count: Number(dedicated), strategy: "dedicated-count" };

  const trailing = textOf(row).match(/\b(\d{1,6})\s+(?:chats?|contactos?|contacts?|elementos?|items?)\s*$/i)?.[1];
  return trailing ? { count: Number(trailing), strategy: "trailing-labelled-count" } : { count: null, strategy: null };
}

function labelsHeadingPresent(root: ParentNode = document): boolean {
  return [...root.querySelectorAll<HTMLElement>("h1,h2,h3,[role='heading'],header")]
    .some((element) => matchesAny(semanticText(element), UI_WORDS.labels));
}

function labelScope(): ParentNode {
  const heading = [...document.querySelectorAll<HTMLElement>("h1,h2,h3,[role='heading'],header")]
    .find((element) => matchesAny(semanticText(element), UI_WORDS.labels));
  return heading?.closest("[role='dialog'],aside,section,[role='list']")
    ?? heading?.parentElement?.parentElement
    ?? document;
}

async function openLabelsHub(signal?: AbortSignal, onVisualOperation?: () => void): Promise<ParentNode> {
  abortIfNeeded(signal);
  if (labelsHeadingPresent()) return labelScope();

  const direct = findInteractiveByAliases(document, UI_WORDS.labels);
  if (direct) click(direct, onVisualOperation);
  else {
    const tools = findInteractiveByAliases(document, UI_WORDS.tools);
    if (tools) click(tools, onVisualOperation);
    else {
      const more = findInteractiveByAliases(document, UI_WORDS.more);
      if (more) click(more, onVisualOperation);
    }
    const labelsButton = await waitForCondition(() => findInteractiveByAliases(document, UI_WORDS.labels), {
      timeoutMs: 2_500,
      signal,
      description: "el acceso a Etiquetas/Listas"
    });
    click(labelsButton, onVisualOperation);
  }

  await waitForCondition(() => labelsHeadingPresent() ? labelScope() : null, {
    timeoutMs: 5_000,
    signal,
    description: "el panel de Etiquetas/Listas"
  });
  return labelScope();
}

export async function detectWhatsAppLabels(signal?: AbortSignal): Promise<{ labels: WhatsAppLabelInfo[]; strategy: string; candidateCount: number }> {
  const scope = await openLabelsHub(signal);
  abortIfNeeded(signal);
  const rows = [...scope.querySelectorAll<HTMLElement>(LABEL_ROW_SELECTOR)]
    .filter(visible)
    .map((row) => ({ row, name: labelNameFromRow(row) }))
    .filter(({ name }) => {
      const normalized = normalizedText(name);
      if (!normalized || normalized.length > 80) return false;
      if (matchesAny(name, UI_WORDS.labels) || matchesAny(name, UI_WORDS.system) || matchesAny(name, UI_WORDS.close)) return false;
      return true;
    });

  const byName = new Map<string, WhatsAppLabelInfo>();
  for (const { row, name } of rows) {
    const key = normalizedText(name);
    if (!key || byName.has(key)) continue;
    const structured = candidateStructuredValues(row);
    const sourceId = structured[0] ?? row.getAttribute("data-label-id") ?? null;
    const count = explicitLabelCount(row);
    byName.set(key, {
      id: opaqueId(`label:${sourceId || key}`),
      name,
      countHint: count.count,
      countHintStrategy: count.strategy,
      sourceId,
      strategy: sourceId ? "semantic-label-hub+structured-id" : "semantic-label-hub"
    });
  }
  const labels = [...byName.values()];
  if (!labels.length) {
    throw new ExtensionError(ERROR_CODES.elementNotFound, "No se encontraron etiquetas o listas de WhatsApp Business en la interfaz visible.", {
      recoverable: true,
      details: {
        contactExportCode: CONTACT_EXPORT_ERROR_CODES.labelsNotFound,
        stage: "detect_labels",
        strategy: "semantic-label-hub",
        candidateCount: rows.length
      }
    });
  }
  return { labels, strategy: "semantic-label-hub", candidateCount: rows.length };
}

function findLabelInteractive(scope: ParentNode, labelName: string): HTMLElement | null {
  const wanted = normalizedText(labelName);
  return [...scope.querySelectorAll<HTMLElement>(LABEL_ROW_SELECTOR)]
    .filter(visible)
    .find((element) => normalizedText(labelNameFromRow(element)) === wanted)
    ?? null;
}

function rowsFromScopedList(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(CONTACT_ROW_SELECTOR)].filter(visible);
  return all.filter((row) => {
    if (row.closest("#main")) return false;
    const ancestor = row.parentElement?.closest<HTMLElement>(CONTACT_ROW_SELECTOR);
    if (ancestor && root.contains(ancestor)) return false;
    return Boolean(textOf(row) || candidateStructuredValues(row).length || row.querySelector("a[href]"));
  });
}

function listFingerprint(root: HTMLElement | null): string {
  if (!root) return "missing";
  const rows = rowsFromScopedList(root).slice(0, 12);
  return rows.map((row) => {
    const ids = candidateStructuredValues(row).slice(0, 3).join("|");
    const pos = row.getAttribute("aria-posinset") || row.getAttribute("aria-rowindex") || "";
    return `${ids}:${pos}:${textOf(row).slice(0, 50)}`;
  }).join("||");
}

function exactLabelMarker(element: HTMLElement, label: WhatsAppLabelInfo): boolean {
  const wanted = normalizedText(label.name);
  const candidates = [element.getAttribute("title"), element.getAttribute("aria-label"), labelNameFromRow(element), textOf(element)]
    .filter(Boolean).map((value) => normalizedText(value));
  return candidates.includes(wanted);
}

function activeLabelMarkers(label: WhatsAppLabelInfo): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(ACTIVE_LABEL_MARKER_SELECTOR)]
    .filter(visible)
    .filter((element) => exactLabelMarker(element, label));
}

function listCandidatesWithin(container: HTMLElement): HTMLElement[] {
  const values = new Set<HTMLElement>();
  if (container.matches(LIST_SELECTOR) || container.id === "pane-side") values.add(container);
  for (const element of container.querySelectorAll<HTMLElement>(LIST_SELECTOR)) {
    if (visible(element) && !element.closest("#main")) values.add(element);
  }
  return [...values];
}

function hasScrollableRange(element: HTMLElement): boolean {
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
}

function scopeContainsGenericLabelsHub(container: HTMLElement): boolean {
  return labelsHeadingPresent(container) && container.querySelectorAll(LABEL_ROW_SELECTOR).length > 1;
}

interface LabelListCandidateEvaluation {
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
  const exceedsExpected = expected != null && rows.length > expected;
  const paneProven = !paneCandidate || paneChanged || markerInsideList;
  const evidenceScore = contactEvidenceScore(rows);

  let reason = 'eligible';
  if (!scrollRelated) reason = 'scroll-not-related';
  else if (genericLabelsHub) reason = 'generic-label-hub';
  else if (rows.length === 0 && expected !== 0) reason = 'no-contact-rows';
  else if (!canReachExpected) reason = 'cannot-reach-reported-count';
  else if (exceedsExpected) reason = 'over-reported-count';
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

async function openLabelScopedView(
  label: WhatsAppLabelInfo,
  signal?: AbortSignal,
  onVisualOperation?: () => void
): Promise<LabelScopedView> {
  const scope = await openLabelsHub(signal, onVisualOperation);
  const target = findLabelInteractive(scope, label.name);
  if (!target) {
    throw new ExtensionError(ERROR_CODES.elementNotFound, "No se pudo encontrar la etiqueta seleccionada.", {
      recoverable: true,
      details: { contactExportCode: CONTACT_EXPORT_ERROR_CODES.labelNotFound, stage: "open_label", labelId: label.id, strategy: "semantic-label-name" }
    });
  }

  const pane = document.querySelector<HTMLElement>("#pane-side");
  const beforePaneFingerprint = listFingerprint(pane);
  click(target, onVisualOperation);

  try {
    return await waitForCondition(() => resolveLabelScopedView(label, beforePaneFingerprint), {
      timeoutMs: 6_000,
      signal,
      description: `el contenedor específico de la etiqueta ${label.name}`
    });
  } catch (error) {
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
}

function hrefPhone(row: Element): { value: string; source: "href_phone" | "tel_link" } | null {
  for (const anchor of row.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = anchor.getAttribute("href") || "";
    if (href.startsWith("tel:")) {
      const value = href.slice(4);
      if (normalizeVisibleInternationalPhone(value)) return { value, source: "tel_link" };
    }
    try {
      const url = new URL(href, location.href);
      const phone = url.searchParams.get("phone");
      if (phone && normalizeStructuredPhone(phone)) return { value: phone, source: "href_phone" };
      if (/wa\.me$/i.test(url.hostname)) {
        const value = url.pathname.replace(/\D/g, "");
        if (value && normalizeStructuredPhone(value)) return { value, source: "href_phone" };
      }
    } catch {
      // href no parseable: se ignora; nunca se transforma en un número inferido.
    }
  }
  return null;
}

function structuredPhone(row: Element): { value: string; source: "structured_phone" } | null {
  const selector = STRUCTURED_PHONE_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(",");
  const nodes = [row, ...[...row.querySelectorAll<HTMLElement>(selector)].slice(0, 30)];
  for (const node of nodes) {
    for (const attribute of STRUCTURED_PHONE_ATTRIBUTES) {
      const value = node.getAttribute(attribute);
      if (value && normalizeStructuredPhone(value)) return { value, source: "structured_phone" };
    }
  }
  return null;
}

function phoneFromStructuredValues(values: string[]): { value: string; source: "jid" } | null {
  for (const value of values) {
    if (normalizeWhatsAppJidPhone(value)) return { value, source: "jid" };
  }
  return null;
}

function visibleInternationalPhone(row: Element): { value: string; source: "visible_international" } | null {
  const values = [row.getAttribute("aria-label"), row.getAttribute("title"), ...[...row.querySelectorAll<HTMLElement>("span[title],span,div")].slice(0, 30).map((element) => element.getAttribute("title") || textOf(element))]
    .filter((value): value is string => Boolean(value))
    .filter((value) => value.trim().startsWith("+") && value.length <= 36);
  for (const value of values) {
    if (normalizeVisibleInternationalPhone(value)) return { value, source: "visible_international" };
  }
  return null;
}

function resolvePhoneFromRow(row: HTMLElement, values: string[]): { value: string; source: Exclude<ContactPhoneSource, "none">; status: "resolved" | "invalid" } | null {
  const sources = [phoneFromStructuredValues(values), structuredPhone(row), hrefPhone(row), visibleInternationalPhone(row)].filter(Boolean) as Array<{ value: string; source: Exclude<ContactPhoneSource, "none"> }>;
  for (const source of sources) {
    if (normalizeExportPhoneCandidate(source.value, source.source)) return { ...source, status: "resolved" };
    return { ...source, status: "invalid" };
  }
  return null;
}

function stableContactId(row: HTMLElement, values: string[]): string | null {
  const structured = values.find((value) => /@(c\.us|s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)/i.test(value))
    ?? values.find((value) => value.length >= 4);
  if (structured) return structured;
  const direct = STRUCTURED_ID_ATTRIBUTES.map((attribute) => row.getAttribute(attribute)).find((value) => value && value.length >= 4);
  return direct || null;
}

function positionalIdentity(row: HTMLElement): string | null {
  const attributes = ["aria-posinset", "aria-rowindex", "data-index", "data-row-index", "data-list-index", "data-item-index"];
  for (const attribute of attributes) {
    const value = row.getAttribute(attribute);
    if (value && /^\d+$/.test(value)) return `position:${attribute}:${value}`;
  }

  const style = row.getAttribute("style") || "";
  const translateY = style.match(/translateY\(\s*(-?\d+(?:\.\d+)?)px\s*\)/i)?.[1]
    ?? style.match(/translate3d\(\s*[^,]+,\s*(-?\d+(?:\.\d+)?)px/i)?.[1]
    ?? style.match(/(?:^|;)\s*top:\s*(-?\d+(?:\.\d+)?)px/i)?.[1];
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
  ].filter((value): value is string => Boolean(value && value.trim())).join("|").replace(/\s+/g, " ").trim();
  if (!structural) return null;
  // Sólo sirve para recorrido/pendientes. Nunca convierte una fila anónima en
  // contacto válido ni permite inventar un teléfono.
  return `anonymous:${opaqueId(`${structural.slice(0, 1200)}:${rowIndex}`)}`;
}

function cleanName(row: HTMLElement, phoneValue: string | null): string {
  const titled = [...row.querySelectorAll<HTMLElement>("span[title],[title]")]
    .map((item) => item.getAttribute("title")?.trim() || "")
    .find((item) => item && item.length <= 160);
  const aria = row.getAttribute("aria-label")?.trim() || "";
  const first = textOf(row).split(/\n| · /)[0]?.trim() || "";
  const value = (titled || (aria.length <= 160 ? aria : "") || first).trim();
  if (!value) return "";
  if (normalizeVisibleInternationalPhone(value)) return "";
  if (/^\+?[\d\s()\-.]{8,25}$/.test(value)) return "";
  if (phoneValue) {
    const normalizedPhone = normalizeStructuredPhone(phoneValue)?.digits;
    const nameDigits = value.replace(/\D/g, "");
    if (normalizedPhone && nameDigits === normalizedPhone) return "";
  }
  return value.slice(0, 160);
}

export function candidateFromScopedLabelRow(row: HTMLElement, label: WhatsAppLabelInfo, rowIndex = 0): RowResolution {
  const values = candidateStructuredValues(row);
  const kind = kindFromValues(values);
  const phone = resolvePhoneFromRow(row, values);
  const normalized = phone?.status === "resolved" ? normalizeExportPhoneCandidate(phone.value, phone.source) : null;
  const contactId = stableContactId(row, values);
  const position = positionalIdentity(row);
  const stableKey = normalized?.digits ? `phone:${normalized.digits}` : contactId ? `contact:${contactId}` : position;
  const countKey = stableKey ?? anonymousTraversalIdentity(row, rowIndex);
  const sourceId = opaqueId(`${label.id}:${stableKey ?? countKey ?? `unresolved-row:${rowIndex}`}`);
  return {
    stableKey,
    countKey,
    candidate: {
      sourceId,
      contactId,
      labelId: label.id,
      labelName: label.name,
      name: cleanName(row, phone?.value ?? null),
      phoneCandidate: phone?.value ?? null,
      phoneSource: phone?.source ?? "none",
      phoneStatus: phone?.status ?? "unresolved",
      kind,
      strategy: phone?.status === "resolved"
        ? `label-row-${phone.source}`
        : contactId
          ? "label-row-contact-id-phone-unresolved"
          : "label-row-phone-unresolved"
    }
  };
}

function labelScopeStillActive(view: LabelScopedView, label: WhatsAppLabelInfo): boolean {
  return view.scopeRoot.isConnected && view.listRoot.isConnected && view.marker.isConnected && exactLabelMarker(view.marker, label);
}

type ScrollState = "more" | "end" | "not-scrollable";

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
}

export async function collectScopedLabelRows(
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

    if (state === "end" && label.countHint == null && stablePasses >= 2) break;
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

    if (state === "not-scrollable" && label.countHint != null && uniqueCount < label.countHint && stablePasses >= 6) {
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
    await new Promise((resolve) => globalThis.setTimeout(resolve, 160));
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

export async function collectContactsForLabels(
  labels: WhatsAppLabelInfo[],
  options: CollectSelectedLabelsOptions = {}
): Promise<ContactExportCollection> {
  if (!labels.length) throw new ExtensionError(ERROR_CODES.invalidInput, "Seleccioná al menos una etiqueta.");
  const startedAt = new Date();
  const results: RawContactCandidate[] = [];
  const labelResults: ContactExportLabelResult[] = [];
  let visualOperations = 0;
  let rowScans = 0;
  let scrollOperations = 0;

  const onVisualOperation = () => { visualOperations += 1; };
  for (let index = 0; index < labels.length; index += 1) {
    abortIfNeeded(options.signal);
    const label = labels[index]!;
    await options.progress?.({
      processed: results.length,
      totalHint: labels.reduce((sum, item) => sum + (item.countHint ?? 0), 0) || null,
      percent: Math.round((index / labels.length) * 100),
      currentLabel: label.name,
      labelIndex: index + 1,
      totalLabels: labels.length,
      currentContact: 0
    });

    const view = await openLabelScopedView(label, options.signal, onVisualOperation);
    const collected = await collectScopedLabelRows(view, label, options, index + 1, labels.length);
    results.push(...collected.candidates);
    labelResults.push(collected.result);
    rowScans += collected.result.rowScans;
    scrollOperations += collected.result.scrollOperations;
    visualOperations += collected.visualOperations;
  }

  const completedAt = new Date();
  const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
  const metrics: ContactExportMetrics = {
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    contactsPerSecond: durationMs > 0 ? Number((results.length / (durationMs / 1000)).toFixed(2)) : null,
    labelsProcessed: labels.length,
    rowScans,
    scrollOperations,
    visualOperations,
    chatsOpened: 0
  };

  await options.progress?.({
    processed: results.length,
    totalHint: results.length,
    percent: 100,
    currentLabel: labels.at(-1)?.name ?? null,
    labelIndex: labels.length,
    totalLabels: labels.length,
    currentContact: results.length
  });
  return { candidates: results, strategy: "label-scoped-phone-first-no-chat-opening", labelResults, metrics };
}

export function contactExportAdapterSupportsCurrentDocument(): boolean {
  return location.origin === "https://web.whatsapp.com"
    && Boolean(document.querySelector("#pane-side,#main,[role='grid'],[aria-label*='chat' i]"));
}

export function classifyContactExportFailure(error: unknown): { code: string; stage: string } {
  if (error instanceof DOMException && error.name === "AbortError") return { code: CONTACT_EXPORT_ERROR_CODES.cancelled, stage: "cancelled" };
  if (error instanceof ExtensionError) {
    return {
      code: String(error.details?.contactExportCode || error.code),
      stage: String(error.details?.stage || "contact_export")
    };
  }
  return { code: CONTACT_EXPORT_ERROR_CODES.contactExtractionFailed, stage: "contact_export" };
}

export function isClearlyNonContactStructuredId(value: string): boolean {
  return NON_CONTACT_JID.test(value);
}
