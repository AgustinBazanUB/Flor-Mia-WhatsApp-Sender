from pathlib import Path
import json

ROOT = Path('.')


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    assert old in text, f'missing pattern in {path}: {old[:120]!r}'
    text = text.replace(old, new, count)
    p.write_text(text, encoding='utf-8')

# -----------------------------------------------------------------------------
# Protocol: allow a structured membership set to ask the DOM pass only for
# phone hydration evidence. The DOM still cannot add contacts to membership.
# -----------------------------------------------------------------------------
replace(
    'src/shared/protocol.ts',
    '''  ContactExportProgress,\n  ContactExportState,\n  RawContactCandidate,\n  WhatsAppLabelInfo\n} from "../contact-export/types";''',
    '''  ContactExportLabelResult,\n  ContactExportMetrics,\n  ContactExportProgress,\n  ContactExportState,\n  RawContactCandidate,\n  WhatsAppLabelInfo\n} from "../contact-export/types";'''
)
replace(
    'src/shared/protocol.ts',
    '''  WA_CONTACT_EXPORT_ANALYZE: { operationId: string; labels: WhatsAppLabelInfo[] };''',
    '''  WA_CONTACT_EXPORT_ANALYZE: {\n    operationId: string;\n    labels: WhatsAppLabelInfo[];\n    hydrationContactIdsByLabel?: Record<string, string[]>;\n  };'''
)
replace(
    'src/shared/protocol.ts',
    '''  WA_CONTACT_EXPORT_ANALYZE: { candidates: RawContactCandidate[]; strategy: string };''',
    '''  WA_CONTACT_EXPORT_ANALYZE: {\n    candidates: RawContactCandidate[];\n    strategy: string;\n    hydratedPhones?: Record<string, string>;\n    hydrationPasses?: number;\n    metrics?: ContactExportMetrics;\n    labelResults?: ContactExportLabelResult[];\n  };'''
)

# -----------------------------------------------------------------------------
# Main-world resolver: broaden local-only LID -> PN evidence, add a batch resolver
# for viewport hydration, and add a strict merge helper keyed only by structured ID.
# -----------------------------------------------------------------------------
resolver_path = ROOT / 'src/contact-export/whatsapp-main-world-resolver.ts'
r = resolver_path.read_text(encoding='utf-8')
r = r.replace(
    'import { CONTACT_EXPORT_ERROR_CODES, type ContactExportCollectionResult, type ContactKind, type RawContactCandidate, type WhatsAppLabelInfo } from "./types";\n',
    'import { CONTACT_EXPORT_ERROR_CODES, type ContactExportCollectionResult, type ContactKind, type RawContactCandidate, type WhatsAppLabelInfo } from "./types";\nimport { normalizeWhatsAppJidPhone } from "./phone-normalizer";\n'
)
r = r.replace(
    '  phoneResolution: "direct-pn" | "contact-phone" | "lid-map" | "unresolved";',
    '  phoneResolution: "direct-pn" | "contact-phone" | "lid-map" | "lid-cache" | "alternate-user" | "frontend-contact" | "contact-record" | "unresolved";'
)
old = '''  const widFactory = safeRequire("WAWebWidFactory");\n  const apiContact = safeRequire("WAWebApiContact");\n  const globalStore = asRecord(globalWindow.Store);\n  const lidUtils = globalStore?.LidUtils;\n  const resolveLidPhone = async (wid: unknown): Promise<string | null> => {\n    const apiMapped = call(apiContact, "getPhoneNumber", wid);\n    if (apiMapped !== undefined) {\n      try {\n        const resolved = await Promise.resolve(apiMapped);\n        const phone = pnJid(resolved);\n        if (phone) return phone;\n      } catch {\n        // Fallback local siguiente.\n      }\n    }\n    const storeMapped = call(lidUtils, "getPhoneNumber", wid);\n    if (storeMapped !== undefined) {\n      try {\n        const resolved = await Promise.resolve(storeMapped);\n        const phone = pnJid(resolved);\n        if (phone) return phone;\n      } catch {\n        // No hay mapeo local para este LID.\n      }\n    }\n    return null;\n  };'''
new = '''  const widFactory = safeRequire("WAWebWidFactory");\n  const apiContact = safeRequire("WAWebApiContact");\n  const apiContactRecord = asRecord(apiContact);\n  const lidPnCache = apiContactRecord?.lidPnCache;\n  const frontendContactGetters = safeRequire("WAWebFrontendContactGetters");\n  const globalStore = asRecord(globalWindow.Store);\n  const lidUtils = globalStore?.LidUtils;\n  const phoneFromUnknown = (value: unknown): string | null => {\n    const direct = pnJid(value);\n    if (direct) return direct;\n    const record = asRecord(value);\n    if (!record) return null;\n    for (const key of ["phoneNumber", "pn", "phone", "wid", "id", "alternateUserWid", "alternateWid"]) {\n      const phone = pnJid(record[key]);\n      if (phone) return phone;\n    }\n    return null;\n  };\n  const resolveAttempt = async (value: unknown): Promise<string | null> => {\n    if (value === undefined || value === null) return null;\n    try {\n      return phoneFromUnknown(await Promise.resolve(value));\n    } catch {\n      return null;\n    }\n  };\n  const resolveLidPhone = async (wid: unknown, contact: unknown): Promise<{ phone: string; resolution: MainWorldContactSnapshot["phoneResolution"] } | null> => {\n    const attempts: Array<[MainWorldContactSnapshot["phoneResolution"], unknown]> = [\n      ["lid-map", call(apiContact, "getPhoneNumber", wid)],\n      ["lid-cache", call(lidPnCache, "getPhoneNumber", wid)],\n      ["lid-cache", get(call(lidPnCache, "getLidEntry", wid), "phoneNumber")],\n      ["alternate-user", call(apiContact, "getAlternateUserWid", wid)],\n      ["alternate-user", call(apiContact, "getPnIfLidIsLatestMapping", wid)],\n      ["frontend-contact", call(frontendContactGetters, "getPnForLid", contact)],\n      ["contact-record", call(apiContact, "getContactRecord", wid)],\n      ["lid-map", call(lidUtils, "getPhoneNumber", wid)]\n    ];\n    for (const [resolution, value] of attempts) {\n      const phone = await resolveAttempt(value);\n      if (phone) return { phone, resolution };\n    }\n    return null;\n  };'''
assert old in r, 'old resolveLidPhone block missing'
r = r.replace(old, new, 1)
r = r.replace(
    '''        const mapped = await resolveLidPhone(wid);\n        if (mapped) {\n          phoneJid = mapped;\n          phoneResolution = "lid-map";\n        }''',
    '''        const mapped = await resolveLidPhone(wid, contact);\n        if (mapped) {\n          phoneJid = mapped.phone;\n          phoneResolution = mapped.resolution;\n        }''',
    1
)
insert_marker = '''function opaqueSourceId(value: string): string {'''
assert insert_marker in r, 'opaqueSourceId marker missing'
batch_code = r'''export interface MainWorldLidResolutionBatch {
  phones: Record<string, string>;
  strategies: Record<string, string>;
  attempted: number;
  resolved: number;
}

/**
 * Resolver autocontenido para ejecutar en world=MAIN mientras el Content Script
 * recorre el viewport virtualizado. Sólo consulta estado/cache local de WhatsApp.
 */
export async function inspectWhatsAppLidsMainWorld(contactIds: string[]): Promise<MainWorldLidResolutionBatch> {
  const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" ? value as Record<string, unknown> : null;
  const get = (target: unknown, key: string): unknown => asRecord(target)?.[key];
  const call = (target: unknown, key: string, ...args: unknown[]): unknown => {
    const fn = get(target, key);
    if (typeof fn !== "function") return undefined;
    try { return Reflect.apply(fn, target, args); } catch { return undefined; }
  };
  const serializedId = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number") return String(value);
    const record = asRecord(value);
    if (!record) return "";
    const direct = [record._serialized, record.serialized, record.id].find((item) => typeof item === "string" && item.trim());
    if (typeof direct === "string") return direct.trim();
    const user = typeof record.user === "string" ? record.user.trim() : "";
    const server = typeof record.server === "string" ? record.server.trim() : "";
    return user && server ? `${user}@${server}` : "";
  };
  const pnJid = (value: unknown): string | null => {
    const serialized = serializedId(value);
    const match = serialized.match(/^(\d{8,15})@(c\.us|s\.whatsapp\.net)$/i);
    if (match?.[1]) return `${match[1]}@c.us`;
    if (/^[1-9]\d{7,14}$/.test(serialized)) return `${serialized}@c.us`;
    return null;
  };
  const phoneFromUnknown = (value: unknown): string | null => {
    const direct = pnJid(value);
    if (direct) return direct;
    const record = asRecord(value);
    if (!record) return null;
    for (const key of ["phoneNumber", "pn", "phone", "wid", "id", "alternateUserWid", "alternateWid"]) {
      const phone = pnJid(record[key]);
      if (phone) return phone;
    }
    return null;
  };
  const globalWindow = window as unknown as { require?: (name: string) => unknown; Store?: unknown };
  const requireFn = globalWindow.require;
  const empty: MainWorldLidResolutionBatch = { phones: {}, strategies: {}, attempted: contactIds.length, resolved: 0 };
  if (typeof requireFn !== "function") return empty;
  const safeRequire = (name: string): unknown => { try { return requireFn(name); } catch { return undefined; } };
  const widFactory = safeRequire("WAWebWidFactory");
  const apiContact = safeRequire("WAWebApiContact");
  const apiRecord = asRecord(apiContact);
  const lidPnCache = apiRecord?.lidPnCache;
  const collections = asRecord(safeRequire("WAWebCollections"));
  const contactCollection = collections?.Contact;
  const frontendGetters = safeRequire("WAWebFrontendContactGetters");
  const lidUtils = asRecord(globalWindow.Store)?.LidUtils;

  const collectionGet = (id: string, wid: unknown): unknown => call(contactCollection, "get", wid) ?? call(contactCollection, "get", id);
  const awaitPhone = async (value: unknown): Promise<string | null> => {
    if (value === undefined || value === null) return null;
    try { return phoneFromUnknown(await Promise.resolve(value)); } catch { return null; }
  };

  const phones: Record<string, string> = {};
  const strategies: Record<string, string> = {};
  for (const id of contactIds) {
    if (!/^\d{8,20}@lid$/i.test(id)) continue;
    const wid = call(widFactory, "createWid", id) ?? { _serialized: id, server: "lid" };
    const contact = collectionGet(id, wid);
    const contactRecord = asRecord(contact);
    const candidates: Array<[string, unknown]> = [
      ["contact-phone", contactRecord?.phoneNumber],
      ["lid-map", call(apiContact, "getPhoneNumber", wid)],
      ["lid-cache", call(lidPnCache, "getPhoneNumber", wid)],
      ["lid-cache-entry", get(call(lidPnCache, "getLidEntry", wid), "phoneNumber")],
      ["alternate-user", call(apiContact, "getAlternateUserWid", wid)],
      ["latest-mapping", call(apiContact, "getPnIfLidIsLatestMapping", wid)],
      ["frontend-contact", call(frontendGetters, "getPnForLid", contact)],
      ["contact-record", call(apiContact, "getContactRecord", wid)],
      ["store-lid-utils", call(lidUtils, "getPhoneNumber", wid)]
    ];
    for (const [strategy, value] of candidates) {
      const phone = await awaitPhone(value);
      if (!phone) continue;
      phones[id] = phone;
      strategies[id] = strategy;
      break;
    }
  }
  return { phones, strategies, attempted: contactIds.length, resolved: Object.keys(phones).length };
}

export async function resolveWhatsAppLidsInMainWorld(tabId: number, contactIds: string[]): Promise<MainWorldLidResolutionBatch> {
  const unique = [...new Set(contactIds.map((id) => id.trim()).filter((id) => /^\d{8,20}@lid$/i.test(id)))].slice(0, 1000);
  if (!unique.length || !chrome.scripting?.executeScript) return { phones: {}, strategies: {}, attempted: unique.length, resolved: 0 };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: inspectWhatsAppLidsMainWorld,
      args: [unique]
    });
    return results[0]?.result as MainWorldLidResolutionBatch ?? { phones: {}, strategies: {}, attempted: unique.length, resolved: 0 };
  } catch {
    return { phones: {}, strategies: {}, attempted: unique.length, resolved: 0 };
  }
}

export interface ContactHydrationEvidence {
  candidates: RawContactCandidate[];
  hydratedPhones?: Record<string, string>;
  hydrationPasses?: number;
  metrics?: ContactExportCollectionResult["metrics"];
  labelResults?: ContactExportCollectionResult["labelResults"];
}

export interface ContactHydrationMergeResult {
  collection: ContactExportCollectionResult;
  attempted: number;
  resolved: number;
  remaining: number;
  passes: number;
}

export function mergeHydratedPhonesIntoCollection(
  structured: ContactExportCollectionResult,
  evidence: ContactHydrationEvidence
): ContactHydrationMergeResult {
  const allowedIds = new Set(structured.candidates.map((candidate) => candidate.contactId?.trim().toLowerCase()).filter((id): id is string => Boolean(id)));
  const phoneById = new Map<string, string>();
  for (const [rawId, rawPhone] of Object.entries(evidence.hydratedPhones ?? {})) {
    const id = rawId.trim().toLowerCase();
    if (!allowedIds.has(id) || !normalizeWhatsAppJidPhone(rawPhone)) continue;
    phoneById.set(id, rawPhone);
  }
  for (const candidate of evidence.candidates) {
    const id = candidate.contactId?.trim().toLowerCase();
    if (!id || !allowedIds.has(id) || candidate.phoneStatus !== "resolved" || !candidate.phoneCandidate || !normalizeWhatsAppJidPhone(candidate.phoneCandidate)) continue;
    if (!phoneById.has(id)) phoneById.set(id, candidate.phoneCandidate);
  }

  const unresolvedBefore = structured.candidates.filter((candidate) => candidate.phoneStatus !== "resolved" && /@lid$/i.test(candidate.contactId ?? "")).length;
  const candidates = structured.candidates.map((candidate) => {
    if (candidate.phoneStatus === "resolved") return candidate;
    const id = candidate.contactId?.trim().toLowerCase();
    const phone = id ? phoneById.get(id) : null;
    if (!phone) return candidate;
    return {
      ...candidate,
      phoneCandidate: phone,
      phoneSource: "jid" as const,
      phoneStatus: "resolved" as const,
      strategy: `${candidate.strategy}+virtualized-lid-hydration`
    };
  });

  const labelResults = structured.labelResults.map((base) => {
    const labelCandidates = candidates.filter((candidate) => candidate.labelId === base.labelId);
    const enriched = evidence.labelResults?.find((item) => item.labelId === base.labelId);
    return {
      ...base,
      resolvedPhones: labelCandidates.filter((candidate) => candidate.phoneStatus === "resolved" && (candidate.kind === "contact" || candidate.kind === "unknown")).length,
      unresolvedPhones: labelCandidates.filter((candidate) => candidate.phoneStatus !== "resolved" && (candidate.kind === "contact" || candidate.kind === "unknown")).length,
      rowScans: enriched?.rowScans ?? base.rowScans,
      scrollOperations: enriched?.scrollOperations ?? base.scrollOperations,
      scopeStrategy: "main-world-label-store+virtualized-lid-hydration"
    };
  });
  const remaining = candidates.filter((candidate) => candidate.phoneStatus !== "resolved" && /@lid$/i.test(candidate.contactId ?? "")).length;
  const resolved = Math.max(0, unresolvedBefore - remaining);
  const metrics = evidence.metrics ? {
    ...evidence.metrics,
    startedAt: structured.metrics.startedAt,
    chatsOpened: 0
  } : structured.metrics;
  if (evidence.metrics) {
    metrics.durationMs = Math.max(0, Date.parse(metrics.completedAt) - Date.parse(metrics.startedAt));
    const processed = labelResults.reduce((sum, item) => sum + item.collectedUniqueContacts, 0);
    metrics.contactsPerSecond = metrics.durationMs > 0 ? Number((processed / (metrics.durationMs / 1000)).toFixed(2)) : null;
  }
  return {
    collection: {
      candidates,
      strategy: "main-world-label-store+virtualized-lid-hydration",
      labelResults,
      metrics
    },
    attempted: unresolvedBefore,
    resolved,
    remaining,
    passes: evidence.hydrationPasses ?? 0
  };
}

'''
r = r.replace(insert_marker, batch_code + insert_marker, 1)
resolver_path.write_text(r, encoding='utf-8')

# -----------------------------------------------------------------------------
# DOM adapter: while scrolling the exact selected label, repeatedly ask the local
# main-world cache to resolve the structured LIDs. If needed, do a second sweep.
# -----------------------------------------------------------------------------
adapter_path = ROOT / 'src/contact-export/whatsapp-contact-adapter.ts'
a = adapter_path.read_text(encoding='utf-8')
a = a.replace(
    '''export interface CollectSelectedLabelsOptions {\n  signal?: AbortSignal;\n  progress?: ContactExportAdapterProgress;\n}''',
    '''export interface CollectSelectedLabelsOptions {\n  signal?: AbortSignal;\n  progress?: ContactExportAdapterProgress;\n  hydrationContactIdsByLabel?: Record<string, string[]>;\n  resolvePhoneHydration?: (contactIds: string[]) => Promise<Record<string, string>>;\n}'''
)
a = a.replace(
    '''export interface ContactExportCollection {\n  candidates: RawContactCandidate[];\n  strategy: string;\n  labelResults: ContactExportLabelResult[];\n  metrics: ContactExportMetrics;\n}''',
    '''export interface ContactExportCollection {\n  candidates: RawContactCandidate[];\n  strategy: string;\n  labelResults: ContactExportLabelResult[];\n  metrics: ContactExportMetrics;\n  hydratedPhones: Record<string, string>;\n  hydrationPasses: number;\n}'''
)
a = a.replace(
    '''  totalLabels: number\n): Promise<{ candidates: RawContactCandidate[]; result: ContactExportLabelResult; visualOperations: number }> {''',
    '''  totalLabels: number\n): Promise<{\n  candidates: RawContactCandidate[];\n  result: ContactExportLabelResult;\n  visualOperations: number;\n  hydratedPhones: Record<string, string>;\n  hydrationPasses: number;\n}> {'''
)
a = a.replace(
    '''  let scrollOperations = 0;\n  let lastUniqueCount = -1;\n\n  for (let pass = 0; pass < 200; pass += 1) {''',
    '''  let scrollOperations = 0;\n  let lastUniqueCount = -1;\n  const pendingHydrationIds = new Set(\n    (options.hydrationContactIdsByLabel?.[label.id] ?? [])\n      .map((id) => id.trim())\n      .filter((id) => /^\\d{8,20}@lid$/i.test(id))\n  );\n  const hydratedPhones = new Map<string, string>();\n  let hydrationPasses = 0;\n  let hydrationSweep = 1;\n\n  const hydratePendingPhones = async (): Promise<void> => {\n    if (!pendingHydrationIds.size || !options.resolvePhoneHydration) return;\n    abortIfNeeded(options.signal);\n    // WhatsApp hidrata metadatos del viewport de forma asíncrona. Un settle corto\n    // evita consultar el cache antes de que termine la virtualización.\n    await new Promise((resolve) => globalThis.setTimeout(resolve, 120));\n    const requested = [...pendingHydrationIds];\n    const resolved = await options.resolvePhoneHydration(requested);\n    hydrationPasses += 1;\n    for (const [contactId, phoneJid] of Object.entries(resolved)) {\n      const normalizedId = contactId.trim();\n      if (!pendingHydrationIds.has(normalizedId) || !normalizeWhatsAppJidPhone(phoneJid)) continue;\n      hydratedPhones.set(normalizedId, phoneJid);\n      pendingHydrationIds.delete(normalizedId);\n    }\n  };\n\n  for (let pass = 0; pass < 400; pass += 1) {'''
)
a = a.replace(
    '''    });\n\n    const uniqueCount = countedRows.size;''',
    '''    });\n\n    await hydratePendingPhones();\n\n    const uniqueCount = countedRows.size;''',
    1
)
old_break = '''    if (label.countHint != null && uniqueCount >= label.countHint) break;\n\n    const state = scrollState(view.scrollRoot);\n    if (uniqueCount === lastUniqueCount) stablePasses += 1;\n    else stablePasses = 0;\n    lastUniqueCount = uniqueCount;'''
new_break = '''    const state = scrollState(view.scrollRoot);\n    const countComplete = label.countHint != null && uniqueCount >= label.countHint;\n    const hydrationActive = Boolean(options.resolvePhoneHydration && (options.hydrationContactIdsByLabel?.[label.id]?.length ?? 0) > 0);\n    if (countComplete && (!hydrationActive || pendingHydrationIds.size === 0)) break;\n    if (countComplete && hydrationActive && state === "end" && hydrationSweep >= 2) break;\n    if (countComplete && hydrationActive && state === "end" && hydrationSweep === 1) {\n      const before = view.scrollRoot.scrollTop;\n      view.scrollRoot.scrollTop = 0;\n      view.scrollRoot.dispatchEvent(new Event("scroll", { bubbles: true }));\n      if (view.scrollRoot.scrollTop !== before) scrollOperations += 1;\n      hydrationSweep = 2;\n      stablePasses = 0;\n      lastUniqueCount = uniqueCount;\n      await new Promise((resolve) => globalThis.setTimeout(resolve, 200));\n      continue;\n    }\n\n    if (uniqueCount === lastUniqueCount) stablePasses += 1;\n    else stablePasses = 0;\n    lastUniqueCount = uniqueCount;'''
assert old_break in a, 'adapter early break block missing'
a = a.replace(old_break, new_break, 1)
a = a.replace(
    '''    if (state === "more" && stablePasses >= 5) {''',
    '''    if (!countComplete && state === "more" && stablePasses >= 5) {''',
    1
)
a = a.replace(
    '''  return {\n    candidates,\n    visualOperations: scrollOperations,\n    result: {''',
    '''  return {\n    candidates,\n    visualOperations: scrollOperations,\n    hydratedPhones: Object.fromEntries(hydratedPhones),\n    hydrationPasses,\n    result: {''',
    1
)
a = a.replace(
    '''  let scrollOperations = 0;\n\n  const onVisualOperation = () => { visualOperations += 1; };''',
    '''  let scrollOperations = 0;\n  const hydratedPhones: Record<string, string> = {};\n  let hydrationPasses = 0;\n\n  const onVisualOperation = () => { visualOperations += 1; };''',
    1
)
a = a.replace(
    '''    visualOperations += collected.visualOperations;\n  }''',
    '''    visualOperations += collected.visualOperations;\n    Object.assign(hydratedPhones, collected.hydratedPhones);\n    hydrationPasses += collected.hydrationPasses;\n  }''',
    1
)
a = a.replace(
    '''  return { candidates: results, strategy: "label-scoped-phone-first-no-chat-opening", labelResults, metrics };''',
    '''  return {\n    candidates: results,\n    strategy: hydrationPasses > 0\n      ? "label-scoped-phone-first+virtualized-lid-hydration"\n      : "label-scoped-phone-first-no-chat-opening",\n    labelResults,\n    metrics,\n    hydratedPhones,\n    hydrationPasses\n  };''',
    1
)
adapter_path.write_text(a, encoding='utf-8')

# -----------------------------------------------------------------------------
# Content script: bridge each visible hydration pass to background, which can
# safely execute the local cache resolver in world=MAIN.
# -----------------------------------------------------------------------------
content_path = ROOT / 'src/content/whatsapp.ts'
c = content_path.read_text(encoding='utf-8')
c = c.replace(
    'const CONTACT_EXPORT_PROGRESS_CHANNEL = "flormia_contact_export_progress_v1";\n',
    'const CONTACT_EXPORT_PROGRESS_CHANNEL = "flormia_contact_export_progress_v1";\nconst CONTACT_EXPORT_LID_RESOLVE_CHANNEL = "flormia_contact_export_lid_resolve_v1";\n'
)
marker = '''function beforeSendCheckpoint(operationId: string, required: boolean) {'''
assert marker in c, 'content beforeSend marker missing'
helper = r'''async function resolveContactExportLids(operationId: string, contactIds: string[]): Promise<Record<string, string>> {
  if (!contactIds.length) return {};
  const response = await chrome.runtime.sendMessage({
    channel: CONTACT_EXPORT_LID_RESOLVE_CHANNEL,
    operationId,
    contactIds
  }) as { ok?: boolean; phones?: Record<string, string> } | undefined;
  if (!response?.ok) return {};
  return response.phones && typeof response.phones === "object" ? response.phones : {};
}

'''
c = c.replace(marker, helper + marker, 1)
old_collect = '''          const collection = await collectContactsForLabels(payload.labels, {\n            signal: controller.signal,\n            progress: (progress) => publishContactExportProgress(payload.operationId, progress)\n          });'''
new_collect = '''          const collection = await collectContactsForLabels(payload.labels, {\n            signal: controller.signal,\n            progress: (progress) => publishContactExportProgress(payload.operationId, progress),\n            ...(payload.hydrationContactIdsByLabel ? {\n              hydrationContactIdsByLabel: payload.hydrationContactIdsByLabel,\n              resolvePhoneHydration: (contactIds: string[]) => resolveContactExportLids(payload.operationId, contactIds)\n            } : {})\n          });'''
assert old_collect in c, 'content collect options block missing'
c = c.replace(old_collect, new_collect, 1)
c = c.replace(
    '''          sendResponse(success<InternalResponseMap["WA_CONTACT_EXPORT_ANALYZE"]>(message.requestId, {\n            candidates: collection.candidates,\n            strategy: collection.strategy\n          }));''',
    '''          sendResponse(success<InternalResponseMap["WA_CONTACT_EXPORT_ANALYZE"]>(message.requestId, {\n            candidates: collection.candidates,\n            strategy: collection.strategy,\n            hydratedPhones: collection.hydratedPhones,\n            hydrationPasses: collection.hydrationPasses,\n            metrics: collection.metrics,\n            labelResults: collection.labelResults\n          }));''',
    1
)
content_path.write_text(c, encoding='utf-8')

# -----------------------------------------------------------------------------
# Contact Export bootstrap: private local resolver channel. It accepts only the
# active operation from WhatsApp content and never persists the phone map.
# -----------------------------------------------------------------------------
bootstrap_path = ROOT / 'src/background/contact-export-bootstrap.ts'
b = bootstrap_path.read_text(encoding='utf-8')
b = b.replace(
    'import { WhatsAppTransport } from "./whatsapp-transport";\n',
    'import { WhatsAppTransport } from "./whatsapp-transport";\nimport { resolveWhatsAppLidsInMainWorld } from "../contact-export/whatsapp-main-world-resolver";\n'
)
b = b.replace(
    'const progressChannel = "flormia_contact_export_progress_v1";\n',
    'const progressChannel = "flormia_contact_export_progress_v1";\nconst lidResolveChannel = "flormia_contact_export_lid_resolve_v1";\n'
)
listener_marker = '''  if (\n    whatsappSender(sender)\n    && message\n    && typeof message === "object"\n    && (message as Record<string, unknown>).channel === progressChannel\n  ) {'''
assert listener_marker in b, 'bootstrap progress listener marker missing'
lid_listener = r'''  if (
    whatsappSender(sender)
    && message
    && typeof message === "object"
    && (message as Record<string, unknown>).channel === lidResolveChannel
  ) {
    const payload = message as Record<string, unknown>;
    const operationId = typeof payload.operationId === "string" ? payload.operationId : "";
    const contactIds = Array.isArray(payload.contactIds)
      ? payload.contactIds.filter((item): item is string => typeof item === "string").slice(0, 1000)
      : [];
    const tabId = sender.tab?.id;
    if (!operationId || typeof tabId !== "number" || !contactIds.length) {
      sendResponse({ ok: false, phones: {} });
      return false;
    }
    void (async () => {
      const state = await runtime.getState();
      if (state.status !== "analyzing" || state.operationId !== operationId) return { phones: {} };
      const resolved = await resolveWhatsAppLidsInMainWorld(tabId, contactIds);
      return { phones: resolved.phones };
    })().then(
      (data) => sendResponse({ ok: true, ...data }),
      () => sendResponse({ ok: false, phones: {} })
    );
    return true;
  }

'''
b = b.replace(listener_marker, lid_listener + listener_marker, 1)
bootstrap_path.write_text(b, encoding='utf-8')

# -----------------------------------------------------------------------------
# Runtime: structured membership is authoritative; DOM pass only hydrates phone
# evidence and its results are merged by exact structured contactId.
# -----------------------------------------------------------------------------
runtime_path = ROOT / 'src/background/contact-export-runtime.ts'
rt = runtime_path.read_text(encoding='utf-8')
rt = rt.replace(
    'import { collectContactsFromWhatsAppMainWorld } from "../contact-export/whatsapp-main-world-resolver";\n',
    'import { collectContactsFromWhatsAppMainWorld, mergeHydratedPhonesIntoCollection } from "../contact-export/whatsapp-main-world-resolver";\n'
)
old_analyze = '''      const structured = await collectContactsFromWhatsAppMainWorld(tab.id, labels);\n      if (structured) {\n        await this.recordProgress({\n          operationId,\n          processed: structured.candidates.length,\n          totalHint: structured.labelResults.reduce((sum, item) => sum + (item.reportedCount ?? item.collectedUniqueContacts), 0) || null,\n          percent: 100,\n          currentLabel: labels.at(-1)?.name ?? null,\n          labelIndex: labels.length,\n          totalLabels: labels.length,\n          currentContact: structured.candidates.length,\n          metrics: structured.metrics,\n          labelResults: structured.labelResults\n        });\n      }\n      const result = structured\n        ? { candidates: structured.candidates, strategy: structured.strategy }\n        : await this.transport.sendWhenContentReady(\n            INTERNAL_MESSAGE_TYPES.whatsappContactExportAnalyze,\n            { operationId, labels },\n            tab.id,\n            Math.max(60_000, labels.length * 60_000)\n          );'''
new_analyze = '''      const structured = await collectContactsFromWhatsAppMainWorld(tab.id, labels);\n      let hydrationStats = { attempted: 0, resolved: 0, remaining: 0, passes: 0 };\n      let structuredResult = structured;\n      if (structured) {\n        const hydrationContactIdsByLabel: Record<string, string[]> = {};\n        for (const label of labels) {\n          const ids = structured.candidates\n            .filter((candidate) => candidate.labelId === label.id && candidate.phoneStatus !== "resolved" && /^\\d{8,20}@lid$/i.test(candidate.contactId ?? ""))\n            .map((candidate) => candidate.contactId!)\n            .filter((id, index, all) => all.indexOf(id) === index);\n          if (ids.length) hydrationContactIdsByLabel[label.id] = ids;\n        }\n        const hydrationAttempted = Object.values(hydrationContactIdsByLabel).reduce((sum, ids) => sum + ids.length, 0);\n        if (hydrationAttempted > 0) {\n          const evidence = await this.transport.sendWhenContentReady(\n            INTERNAL_MESSAGE_TYPES.whatsappContactExportAnalyze,\n            { operationId, labels, hydrationContactIdsByLabel },\n            tab.id,\n            Math.max(120_000, labels.length * 120_000)\n          );\n          const merged = mergeHydratedPhonesIntoCollection(structured, evidence);\n          structuredResult = merged.collection;\n          hydrationStats = { attempted: merged.attempted, resolved: merged.resolved, remaining: merged.remaining, passes: merged.passes };\n        }\n        const completedStructured = structuredResult ?? structured;\n        await this.recordProgress({\n          operationId,\n          processed: completedStructured.candidates.length,\n          totalHint: completedStructured.labelResults.reduce((sum, item) => sum + (item.reportedCount ?? item.collectedUniqueContacts), 0) || null,\n          percent: 100,\n          currentLabel: labels.at(-1)?.name ?? null,\n          labelIndex: labels.length,\n          totalLabels: labels.length,\n          currentContact: completedStructured.candidates.length,\n          metrics: completedStructured.metrics,\n          labelResults: completedStructured.labelResults\n        });\n      }\n      const result = structuredResult\n        ? { candidates: structuredResult.candidates, strategy: structuredResult.strategy }\n        : await this.transport.sendWhenContentReady(\n            INTERNAL_MESSAGE_TYPES.whatsappContactExportAnalyze,\n            { operationId, labels },\n            tab.id,\n            Math.max(60_000, labels.length * 60_000)\n          );'''
assert old_analyze in rt, 'runtime structured analyze block missing'
rt = rt.replace(old_analyze, new_analyze, 1)
rt = rt.replace(
    '''          lastSuccessfulStep: "label_scoped_phone_first_analysis_completed",''',
    '''          lastSuccessfulStep: hydrationStats.attempted > 0\n            ? "virtualized_lid_phone_hydration_completed"\n            : "label_scoped_phone_first_analysis_completed",''',
    1
)
rt = rt.replace(
    '''          collectedUniqueContacts: lastLabelResult?.collectedUniqueContacts ?? deduplicated.summary.found,\n          updatedAt: new Date().toISOString()''',
    '''          collectedUniqueContacts: lastLabelResult?.collectedUniqueContacts ?? deduplicated.summary.found,\n          technicalDetails: hydrationStats.attempted > 0 ? {\n            phoneHydrationAttempted: hydrationStats.attempted,\n            phoneHydrationResolved: hydrationStats.resolved,\n            phoneHydrationRemaining: hydrationStats.remaining,\n            phoneHydrationPasses: hydrationStats.passes\n          } : {},\n          updatedAt: new Date().toISOString()''',
    1
)
runtime_path.write_text(rt, encoding='utf-8')

# -----------------------------------------------------------------------------
# Tests: local lidPnCache path, exact-ID merge, and a 210-contact virtualized
# hydration pass proving that all blocks can be resolved without chat opening.
# -----------------------------------------------------------------------------
test_path = ROOT / 'tests/contact-export-hydration.test.ts'
test_path.write_text(r'''// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectWhatsAppLidsMainWorld,
  mainWorldSnapshotToCollection,
  mergeHydratedPhonesIntoCollection,
  type MainWorldContactExportSnapshot
} from "../src/contact-export/whatsapp-main-world-resolver";
import { collectScopedLabelRows, type LabelScopedView } from "../src/contact-export/whatsapp-contact-adapter";
import type { WhatsAppLabelInfo } from "../src/contact-export/types";

function label(countHint = 210): WhatsAppLabelInfo {
  return {
    id: "label-210",
    name: "Wh-Junio/Julio15-2025",
    countHint,
    countHintStrategy: "dedicated-count",
    sourceId: "internal-label-210",
    strategy: "semantic-label-hub"
  };
}

function setScrollGeometry(element: HTMLElement, clientHeight: number, scrollHeight: number): void {
  let top = 0;
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = Math.max(0, Math.min(scrollHeight - clientHeight, Number(value) || 0)); }
  });
}

afterEach(() => {
  delete (window as unknown as { require?: unknown }).require;
  delete (window as unknown as { Store?: unknown }).Store;
  document.body.innerHTML = "";
});

describe("Contact Export virtualized LID hydration", () => {
  it("uses the local lidPnCache entry when direct getPhoneNumber is not hydrated", async () => {
    Object.defineProperty(window, "require", {
      configurable: true,
      value: (moduleName: string) => {
        if (moduleName === "WAWebWidFactory") return { createWid: (id: string) => ({ _serialized: id, server: "lid" }) };
        if (moduleName === "WAWebApiContact") return {
          getPhoneNumber: () => undefined,
          lidPnCache: {
            getPhoneNumber: () => undefined,
            getLidEntry: () => ({ phoneNumber: { _serialized: "5491123456789@c.us", server: "c.us" } })
          }
        };
        if (moduleName === "WAWebCollections") return { Contact: { get: () => undefined } };
        return {};
      }
    });
    const result = await inspectWhatsAppLidsMainWorld(["123456789012345@lid"]);
    expect(result).toMatchObject({ attempted: 1, resolved: 1 });
    expect(result.phones["123456789012345@lid"]).toBe("5491123456789@c.us");
    expect(result.strategies["123456789012345@lid"]).toBe("lid-cache-entry");
  });

  it("merges phone evidence only when contactId belongs to structured label membership", () => {
    const snapshot: MainWorldContactExportSnapshot = {
      supported: true,
      reason: null,
      labels: [{
        requestedName: "Wh-Junio/Julio15-2025",
        found: true,
        internalLabelId: "internal-label-210",
        chatCount: 2,
        entries: [
          { chatId: "111111111111111@lid", phoneJid: null, name: "Uno", kind: "contact", phoneResolution: "unresolved" },
          { chatId: "222222222222222@lid", phoneJid: null, name: "Dos", kind: "contact", phoneResolution: "unresolved" }
        ]
      }]
    };
    const structured = mainWorldSnapshotToCollection(snapshot, [label(2)])!;
    const merged = mergeHydratedPhonesIntoCollection(structured, {
      candidates: [],
      hydratedPhones: {
        "111111111111111@lid": "5491100000001@c.us",
        "999999999999999@lid": "5491199999999@c.us"
      },
      hydrationPasses: 3
    });
    expect(merged.collection.candidates[0]?.phoneStatus).toBe("resolved");
    expect(merged.collection.candidates[1]?.phoneStatus).toBe("unresolved");
    expect(merged.resolved).toBe(1);
    expect(merged.remaining).toBe(1);
    expect(merged.passes).toBe(3);
  });

  it("walks a 210-contact virtualized label and hydrates every LID without opening chats", async () => {
    const ids = Array.from({ length: 210 }, (_, index) => `${String(700000000000000 + index)}@lid`);
    document.body.innerHTML = `<section id="scope"><h2 id="marker" title="Wh-Junio/Julio15-2025">Wh-Junio/Julio15-2025</h2><div id="list" role="list"></div></section>`;
    const scope = document.getElementById("scope")!;
    const marker = document.getElementById("marker")!;
    const list = document.getElementById("list")!;
    const pageSize = 18;
    const step = 425;
    const render = (): void => {
      const page = Math.min(Math.floor(list.scrollTop / step), Math.ceil(ids.length / pageSize) - 1);
      const start = page * pageSize;
      list.innerHTML = ids.slice(start, start + pageSize).map((id, offset) =>
        `<div role="listitem" aria-posinset="${start + offset + 1}" data-contact-id="${id}"><span title="Cliente ${start + offset + 1}">Cliente</span></div>`
      ).join("");
    };
    setScrollGeometry(list, 500, 500 + step * 11);
    list.addEventListener("scroll", render);
    render();
    const view: LabelScopedView = { scopeRoot: scope, listRoot: list, scrollRoot: list, marker, strategy: "virtualized-210-test" };
    const result = await collectScopedLabelRows(view, label(210), {
      hydrationContactIdsByLabel: { "label-210": ids },
      resolvePhoneHydration: async (pending) => {
        const visible = new Set([...list.querySelectorAll<HTMLElement>("[data-contact-id]")].map((row) => row.dataset.contactId || ""));
        return Object.fromEntries(pending.filter((id) => visible.has(id)).map((id) => {
          const index = ids.indexOf(id);
          return [id, `${5491100000000 + index}@c.us`];
        }));
      }
    }, 1, 1);
    expect(result.result.collectedUniqueContacts).toBe(210);
    expect(Object.keys(result.hydratedPhones)).toHaveLength(210);
    expect(result.hydrationPasses).toBeGreaterThan(1);
    expect(result.result.scrollOperations).toBeGreaterThan(0);
    expect(document.querySelector("#main")).toBeNull();
  });
});
''', encoding='utf-8')

# -----------------------------------------------------------------------------
# Release metadata and build validator.
# -----------------------------------------------------------------------------
for filename in ['manifest.json', 'package.json', 'package-lock.json']:
    path = ROOT / filename
    data = json.loads(path.read_text(encoding='utf-8'))
    data['version'] = '0.9.5.4'
    if filename == 'manifest.json':
        data['version_name'] = '0.9.5.4'
    if filename == 'package-lock.json':
        data.setdefault('packages', {}).setdefault('', {})['version'] = '0.9.5.4'
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

validate_path = ROOT / 'scripts/validate-build.mjs'
v = validate_path.read_text(encoding='utf-8')
v = v.replace('sourceManifest.version !== "0.9.5.3"', 'sourceManifest.version !== "0.9.5.4"')
v = v.replace('La release esperada para el extractor estructurado es 0.9.5.3.', 'La release esperada para el extractor estructurado es 0.9.5.4.')
v = v.replace('diagnóstico 0.9.5.3.', 'diagnóstico 0.9.5.4.')
v = v.replace('estrategia 0.9.5.3 label-scoped/phone-first.', 'estrategia 0.9.5.4 label-scoped/phone-first.')
v = v.replace('resolver estructurado local de etiquetas/LID de 0.9.5.3.', 'resolver estructurado local de etiquetas/LID de 0.9.5.4.')
needle = '''if (!backgroundWorker.includes("WAWebCollections") || !backgroundWorker.includes("WAWebApiContact") || !backgroundWorker.includes("main-world-label-store+local-lid-map")) {\n  throw new Error("El build no contiene el resolver estructurado local de etiquetas/LID de 0.9.5.4.");\n}\n'''
assert needle in v, 'updated build main-world assertion missing'
v = v.replace(needle, needle + '''if (!backgroundWorker.includes("virtualized-lid-hydration") || !whatsappContent.includes("flormia_contact_export_lid_resolve_v1")) {\n  throw new Error("El build no contiene la hidratación virtualizada LID→teléfono de 0.9.5.4.");\n}\n''')
validate_path.write_text(v, encoding='utf-8')

# -----------------------------------------------------------------------------
# Documentation.
# -----------------------------------------------------------------------------
readme = ROOT / 'README.md'
rd = readme.read_text(encoding='utf-8')
rd = rd.replace('## Contactos de WhatsApp — 0.9.5.3', '## Contactos de WhatsApp — 0.9.5.4')
rd = rd.replace('La versión 0.9.5.3 usa como fuente primaria', 'La versión 0.9.5.4 usa como fuente primaria')
rd = rd.replace('Contact Export 0.9.5.3 deja pendiente únicamente', 'Contact Export 0.9.5.4 deja pendiente únicamente')
anchor = '- resuelve JID telefónico directo y mapea IDs `@lid` al teléfono mediante datos/módulos locales ya cargados por WhatsApp;\n'
if anchor in rd:
    rd = rd.replace(anchor, anchor + '- cuando una lista grande sólo tiene el mapa LID→teléfono del viewport actual, recorre la lista virtualizada (hasta dos barridos) y reconsulta el cache local por bloque, sin abrir chats;\n', 1)
readme.write_text(rd, encoding='utf-8')

doc = ROOT / 'docs/whatsapp-contact-export.md'
d = doc.read_text(encoding='utf-8')
d = d.replace('# Exportación de contactos de WhatsApp Business — 0.9.5.3', '# Exportación de contactos de WhatsApp Business — 0.9.5.4')
section = '''\n## Cambio 0.9.5.4 — hidratación de teléfonos en listas virtualizadas\n\nUna prueba real con `Wh-Junio/Julio15-2025` demostró que la colección estructurada podía enumerar 210/210 miembros en milisegundos, pero sólo 18 teléfonos estaban presentes inicialmente en el cache LID→PN. Ese patrón coincide con el bloque que WhatsApp mantiene materializado en el viewport.\n\n0.9.5.4 conserva `labelItemCollection` como fuente autoritativa de **membresía** y usa el DOM únicamente como mecanismo de hidratación: abre la etiqueta, desplaza su propio viewport sin abrir conversaciones y, después de cada bloque renderizado, vuelve a consultar en `world: MAIN` los LID estructurados todavía pendientes. Si al llegar al final quedan pendientes, realiza un segundo barrido desde arriba.\n\nLa evidencia de teléfono sólo puede fusionarse por `contactId` exacto que ya pertenezca al conjunto estructurado. Una fila DOM externa, un nombre coincidente o una posición visual nunca pueden agregar un contacto al Excel. La resolución local prueba `WAWebApiContact.getPhoneNumber`, `lidPnCache`, `getLidEntry`, alternate-user/latest mapping, `WAWebFrontendContactGetters.getPnForLid`, contact record y `Store.LidUtils`, sin `Contact.find`, sin endpoints privados y sin abrir chats.\n\nSi después de dos barridos un LID realmente no tiene asociación PN disponible localmente, permanece `PHONE_UNRESOLVED`; no se infiere ni inventa un número.\n'''
if '## Cambio 0.9.5.4 — hidratación de teléfonos en listas virtualizadas' not in d:
    d = d + section
doc.write_text(d, encoding='utf-8')

release_notes = ROOT / 'docs/contact-export-release-notes-0.9.5.4.md'
release_notes.write_text('''# Contact Export 0.9.5.4\n\n## Evidencia real\n\nLa etiqueta `Wh-Junio/Julio15-2025` reportó 210 contactos y 0.9.5.3 recolectó exactamente 210 IDs estructurados, pero sólo resolvió 18 teléfonos; 192 quedaron `PHONE_UNRESOLVED`. La ejecución duró 7 ms y tuvo 0 scrolls, confirmando que la fase estructurada terminaba antes de hidratar la lista virtualizada.\n\n## Corrección\n\n- `labelItemCollection` sigue siendo la única fuente de membresía.\n- Se amplían los resolvers locales LID→PN (`getPhoneNumber`, `lidPnCache`, `getLidEntry`, alternate/latest mapping, frontend getter y contact record).\n- Cuando quedan LID pendientes, el Content Script recorre sólo el viewport de la etiqueta y reconsulta el cache local después de cada bloque.\n- Existe un segundo barrido de seguridad si el primero llega al final con pendientes.\n- La fusión de teléfonos exige coincidencia exacta de `contactId` contra los IDs estructurados.\n- No se abren chats ni se usan endpoints privados de WhatsApp.\n- El reporte final incorpora cantidad intentada, resuelta, remanente y número de consultas de hidratación.\n\n## Seguridad\n\nUn contacto que no pertenece a la colección estructurada nunca puede incorporarse por evidencia DOM. Un LID sin PN demostrable continúa como `PHONE_UNRESOLVED`.\n''', encoding='utf-8')

print('Applied Contact Export 0.9.5.4 virtualized LID hydration patch')
