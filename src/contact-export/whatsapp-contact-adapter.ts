import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { waitForCondition } from "../whatsapp/wait";
import { normalizeVisibleInternationalPhone, normalizeWhatsAppJidPhone } from "./phone-normalizer";
import {
  CONTACT_EXPORT_ERROR_CODES,
  type ContactExportProgress,
  type ContactKind,
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
const INTERACTIVE_SELECTOR = "button,[role='button'],[role='menuitem'],[role='listitem'],[role='option'],[tabindex='0']";
const LABEL_ROW_SELECTOR = "[role='listitem'],[role='option'],button,[role='button']";
const CHAT_ROW_SELECTOR = "[role='row'],[role='listitem'],[data-testid*='cell'],[data-testid*='chat'],div[tabindex='-1']";

export interface ContactExportAdapterProgress {
  (progress: Omit<ContactExportProgress, "operationId" | "updatedAt">): void | Promise<void>;
}

export interface CollectSelectedLabelsOptions {
  signal?: AbortSignal;
  progress?: ContactExportAdapterProgress;
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
  return [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    textOf(element)
  ].filter(Boolean).join(" ");
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

function click(element: HTMLElement): void {
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
  const nodes = [element, ...[...element.querySelectorAll<HTMLElement>("[data-jid],[data-chat-id],[data-peer-id],[data-contact-id],[data-id]")].slice(0, 30)];
  for (const node of nodes) {
    for (const attribute of STRUCTURED_ID_ATTRIBUTES) {
      const value = node.getAttribute(attribute);
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

function phoneFromStructuredValues(values: string[]): { value: string; source: "jid" } | null {
  for (const value of values) {
    const normalized = normalizeWhatsAppJidPhone(value);
    if (normalized) return { value, source: "jid" };
  }
  return null;
}

function bestName(element: Element): string {
  const titled = [...element.querySelectorAll<HTMLElement>("span[title],[title]")]
    .map((item) => item.getAttribute("title")?.trim() || "")
    .find((item) => item && item.length <= 160);
  if (titled) return titled;
  const aria = element.getAttribute("aria-label")?.trim();
  if (aria && aria.length <= 160 && !matchesAny(aria, UI_WORDS.more)) return aria;
  const firstLine = textOf(element).split(/\n| · /)[0]?.trim() || "";
  return firstLine.length <= 160 ? firstLine : firstLine.slice(0, 160);
}

function labelCountHint(value: string): number | null {
  const numbers = [...value.matchAll(/\b(\d{1,6})\b/g)].map((match) => Number(match[1]));
  return numbers.length ? numbers.at(-1) ?? null : null;
}

function labelNameFromRow(row: Element): string {
  const title = row.querySelector<HTMLElement>("[title]")?.getAttribute("title")?.trim();
  if (title && title.length <= 80) return title;
  const text = textOf(row);
  if (!text) return "";
  return text.replace(/\s+\d{1,6}(?:\s+(?:chats?|elementos?|items?))?\s*$/i, "").trim().slice(0, 80);
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

async function openLabelsHub(signal?: AbortSignal): Promise<ParentNode> {
  abortIfNeeded(signal);
  if (labelsHeadingPresent()) return labelScope();

  const direct = findInteractiveByAliases(document, UI_WORDS.labels);
  if (direct) click(direct);
  else {
    const tools = findInteractiveByAliases(document, UI_WORDS.tools);
    if (tools) click(tools);
    else {
      const more = findInteractiveByAliases(document, UI_WORDS.more);
      if (more) click(more);
    }
    await waitForCondition(() => findInteractiveByAliases(document, UI_WORDS.labels), {
      timeoutMs: 2_500,
      signal,
      description: "el acceso a Etiquetas/Listas"
    }).then(click);
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
    .map((row) => ({ row, name: labelNameFromRow(row), raw: textOf(row) }))
    .filter(({ name }) => {
      const normalized = normalizedText(name);
      if (!normalized || normalized.length > 80) return false;
      if (matchesAny(name, UI_WORDS.labels) || matchesAny(name, UI_WORDS.system) || matchesAny(name, UI_WORDS.close)) return false;
      return true;
    });

  const byName = new Map<string, WhatsAppLabelInfo>();
  for (const { name, raw } of rows) {
    const key = normalizedText(name);
    if (!key || byName.has(key)) continue;
    byName.set(key, {
      id: opaqueId(`label:${key}`),
      name,
      countHint: labelCountHint(raw),
      strategy: "semantic-label-hub"
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

async function openLabel(label: WhatsAppLabelInfo, signal?: AbortSignal): Promise<void> {
  const scope = await openLabelsHub(signal);
  const target = findLabelInteractive(scope, label.name);
  if (!target) {
    throw new ExtensionError(ERROR_CODES.elementNotFound, `No se pudo abrir la etiqueta seleccionada.`, {
      recoverable: true,
      details: {
        contactExportCode: CONTACT_EXPORT_ERROR_CODES.labelsNotFound,
        stage: "open_label",
        labelId: label.id,
        strategy: "semantic-label-name"
      }
    });
  }
  click(target);
  await waitForCondition(() => findChatListRoot(), {
    timeoutMs: 5_000,
    signal,
    description: "el listado de contactos de la etiqueta"
  });
}

function findChatListRoot(): HTMLElement | null {
  const pane = document.querySelector<HTMLElement>("#pane-side");
  if (pane && visible(pane)) return pane;
  const candidates = [...document.querySelectorAll<HTMLElement>("[role='grid'],[role='list'],[aria-label]")]
    .filter(visible)
    .filter((element) => {
      const semantic = normalizedText(element.getAttribute("aria-label") || "");
      const looksLikeChats = /chat|chats|conversacion|conversaciones/.test(semantic);
      return looksLikeChats || element.querySelectorAll(CHAT_ROW_SELECTOR).length >= 1;
    });
  return candidates.sort((a, b) => b.querySelectorAll(CHAT_ROW_SELECTOR).length - a.querySelectorAll(CHAT_ROW_SELECTOR).length)[0] ?? null;
}

function rowsFromChatList(root: HTMLElement): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  for (const row of root.querySelectorAll<HTMLElement>(CHAT_ROW_SELECTOR)) {
    if (!visible(row) || seen.has(row)) continue;
    const text = textOf(row);
    const values = candidateStructuredValues(row);
    if (!text && !values.length) continue;
    if (row.closest("#main")) continue;
    seen.add(row);
  }
  return [...seen];
}

function sourceIdForRow(row: Element): string {
  const structured = candidateStructuredValues(row).join("|");
  const stable = structured || `${bestName(row)}|${row.getAttribute("role") || ""}|${row.getAttribute("data-testid") || ""}`;
  return opaqueId(stable);
}

function candidateFromRow(row: HTMLElement, labelName: string): RawContactCandidate {
  const values = candidateStructuredValues(row);
  const phone = phoneFromStructuredValues(values);
  return {
    sourceId: sourceIdForRow(row),
    labelName,
    name: bestName(row),
    phoneCandidate: phone?.value ?? null,
    phoneSource: phone?.source ?? "none",
    kind: kindFromValues(values),
    strategy: phone ? "label-row-jid" : "label-row-semantic"
  };
}

function personalPhoneFromScope(scope: ParentNode): { value: string; source: "jid" | "tel_link" | "visible_international" } | null {
  for (const element of [scope as Element, ...[...scope.querySelectorAll?.<HTMLElement>("[data-jid],[data-chat-id],[data-peer-id],[data-contact-id],[data-id]") ?? []].slice(0, 80)]) {
    if (!(element instanceof Element)) continue;
    for (const value of candidateStructuredValues(element)) {
      const normalized = normalizeWhatsAppJidPhone(value);
      if (normalized) return { value, source: "jid" };
    }
  }
  const tel = scope.querySelector?.<HTMLAnchorElement>("a[href^='tel:']");
  if (tel?.getAttribute("href")) {
    const value = tel.getAttribute("href")!.slice(4);
    if (normalizeVisibleInternationalPhone(value)) return { value, source: "tel_link" };
  }
  const shortTextNodes = [...(scope.querySelectorAll?.<HTMLElement>("span,div,p") ?? [])]
    .filter(visible)
    .map((element) => textOf(element))
    .filter((value) => value.startsWith("+") && value.length <= 32);
  for (const value of shortTextNodes) {
    if (normalizeVisibleInternationalPhone(value)) return { value, source: "visible_international" };
  }
  return null;
}

function profilePanel(): HTMLElement | null {
  const candidates = [...document.querySelectorAll<HTMLElement>("aside,[role='dialog']")].filter(visible);
  return candidates.find((panel) => !panel.closest("#main") && Boolean(personalPhoneFromScope(panel)))
    ?? candidates.at(-1)
    ?? null;
}

function profileKind(panel: ParentNode | null): ContactKind | null {
  if (!panel) return null;
  const text = normalizedText(textOf(panel as Element).slice(0, 240));
  if (/info(?:rmacion)? del grupo|group info|participantes|participants/.test(text)) return "group";
  if (/canal|channel|newsletter/.test(text)) return "channel";
  if (/comunidad|community/.test(text)) return "community";
  return null;
}

async function enrichCandidateFromConversation(
  row: HTMLElement,
  candidate: RawContactCandidate,
  signal?: AbortSignal
): Promise<RawContactCandidate> {
  if (candidate.kind !== "unknown" && candidate.phoneCandidate) return candidate;
  abortIfNeeded(signal);
  if (!row.isConnected) return candidate;
  click(row);
  const header = await waitForCondition(() => document.querySelector<HTMLElement>("#main header"), {
    timeoutMs: 3_500,
    signal,
    description: "el encabezado del contacto"
  }).catch(() => null);
  if (!header) return candidate;

  const headerValues = candidateStructuredValues(header);
  const headerKind = kindFromValues(headerValues);
  const headerPhone = phoneFromStructuredValues(headerValues);
  let next: RawContactCandidate = {
    ...candidate,
    name: bestName(header) || candidate.name,
    kind: headerKind === "unknown" ? candidate.kind : headerKind,
    phoneCandidate: headerPhone?.value ?? candidate.phoneCandidate,
    phoneSource: headerPhone?.source ?? candidate.phoneSource,
    strategy: headerPhone ? "chat-header-jid" : candidate.strategy
  };
  if (next.phoneCandidate || next.kind !== "unknown") return next;

  click(header);
  const panel = await waitForCondition(() => profilePanel(), {
    timeoutMs: 2_500,
    signal,
    description: "la ficha del contacto"
  }).catch(() => null);
  if (!panel) return next;
  const kind = profileKind(panel);
  const phone = personalPhoneFromScope(panel);
  next = {
    ...next,
    kind: kind ?? (phone ? "contact" : next.kind),
    phoneCandidate: phone?.value ?? null,
    phoneSource: phone?.source ?? "none",
    strategy: phone ? `contact-profile-${phone.source}` : "contact-profile-no-phone"
  };
  const closeButton = findInteractiveByAliases(panel, UI_WORDS.close);
  if (closeButton) click(closeButton);
  return next;
}

async function collectCurrentLabelRows(
  label: WhatsAppLabelInfo,
  options: CollectSelectedLabelsOptions,
  labelIndex: number,
  totalLabels: number
): Promise<RawContactCandidate[]> {
  const root = findChatListRoot();
  if (!root) {
    throw new ExtensionError(ERROR_CODES.elementNotFound, "No se encontró el listado de chats/contactos de la etiqueta.", {
      recoverable: true,
      details: {
        contactExportCode: CONTACT_EXPORT_ERROR_CODES.contactListNotFound,
        stage: "read_label_contacts",
        labelId: label.id,
        strategy: "semantic-chat-list"
      }
    });
  }

  const collected = new Map<string, RawContactCandidate>();
  let stablePasses = 0;
  let previousSize = -1;
  const totalHint = label.countHint;

  for (let pass = 0; pass < 100 && stablePasses < 3; pass += 1) {
    abortIfNeeded(options.signal);
    const rows = rowsFromChatList(root);
    for (const row of rows) {
      abortIfNeeded(options.signal);
      const base = candidateFromRow(row, label.name);
      if (collected.has(base.sourceId)) continue;
      const enriched = await enrichCandidateFromConversation(row, base, options.signal);
      collected.set(base.sourceId, enriched);
      const processed = collected.size;
      if (processed === 1 || processed % 5 === 0) {
        const percent = totalHint && totalHint > 0 ? Math.min(100, Math.round((processed / totalHint) * 100)) : null;
        await options.progress?.({
          processed,
          totalHint,
          percent,
          currentLabel: label.name,
          labelIndex,
          totalLabels,
          currentContact: processed
        });
      }
    }

    if (collected.size === previousSize) stablePasses += 1;
    else stablePasses = 0;
    previousSize = collected.size;
    const before = root.scrollTop;
    root.scrollTop = Math.min(root.scrollHeight, root.scrollTop + Math.max(root.clientHeight, 600));
    root.dispatchEvent(new Event("scroll", { bubbles: true }));
    if (root.scrollTop === before || root.scrollTop + root.clientHeight >= root.scrollHeight - 4) stablePasses += 1;
    if (stablePasses < 3) await new Promise((resolve) => globalThis.setTimeout(resolve, 120));
  }

  return [...collected.values()];
}

export async function collectContactsForLabels(
  labels: WhatsAppLabelInfo[],
  options: CollectSelectedLabelsOptions = {}
): Promise<RawContactCandidate[]> {
  if (!labels.length) throw new ExtensionError(ERROR_CODES.invalidInput, "Seleccioná al menos una etiqueta.");
  const results: RawContactCandidate[] = [];
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
    await openLabel(label, options.signal);
    const candidates = await collectCurrentLabelRows(label, options, index + 1, labels.length);
    results.push(...candidates);
  }
  await options.progress?.({
    processed: results.length,
    totalHint: results.length,
    percent: 100,
    currentLabel: labels.at(-1)?.name ?? null,
    labelIndex: labels.length,
    totalLabels: labels.length,
    currentContact: results.length
  });
  return results;
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
