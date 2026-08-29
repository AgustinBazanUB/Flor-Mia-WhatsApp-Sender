from pathlib import Path
import json
import re

ROOT = Path('.')


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding='utf-8')


def replace_once(content: str, old: str, new: str, label: str) -> str:
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return content.replace(old, new, 1)


def regex_once(content: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f'{label}: expected one regex match, found {count}')
    return updated

# --- MAIN world resolver: local cache first, then non-visual server-assisted LID lookup.
path = 'src/contact-export/whatsapp-main-world-resolver.ts'
text = read(path)
text = replace_once(
    text,
    '''export interface MainWorldLidResolutionBatch {\n  phones: Record<string, string>;\n  strategies: Record<string, string>;\n  attempted: number;\n  resolved: number;\n}''',
    '''export interface MainWorldLidResolutionBatch {\n  phones: Record<string, string>;\n  strategies: Record<string, string>;\n  attempted: number;\n  resolved: number;\n  localResolved: number;\n  serverQueried: number;\n  serverResolved: number;\n  querySupported: boolean;\n}''',
    'MainWorldLidResolutionBatch interface'
)
text = replace_once(
    text,
    '''  const frontendGetters = safeRequire("WAWebFrontendContactGetters");\n  const lidUtils = asRecord(globalWindow.Store)?.LidUtils;\n\n  const collectionGet = (id: string, wid: unknown): unknown => call(contactCollection, "get", wid) ?? call(contactCollection, "get", id);''',
    '''  const frontendGetters = safeRequire("WAWebFrontendContactGetters");\n  const lidUtils = asRecord(globalWindow.Store)?.LidUtils;\n  const queryExistsJob = safeRequire("WAWebQueryExistsJob");\n  const querySupported = typeof get(queryExistsJob, "queryWidExists") === "function";\n\n  const collectionGet = (id: string, wid: unknown): unknown => call(contactCollection, "get", wid) ?? call(contactCollection, "get", id);''',
    'queryExists module insertion'
)
text = replace_once(
    text,
    '''  const empty: MainWorldLidResolutionBatch = { phones: {}, strategies: {}, attempted: contactIds.length, resolved: 0 };''',
    '''  const empty: MainWorldLidResolutionBatch = {\n    phones: {}, strategies: {}, attempted: contactIds.length, resolved: 0,\n    localResolved: 0, serverQueried: 0, serverResolved: 0, querySupported: false\n  };''',
    'empty batch expansion'
)
text = regex_once(
    text,
    r'''  const phones: Record<string, string> = \{\};\n  const strategies: Record<string, string> = \{\};\n  for \(const id of contactIds\) \{.*?\n  return \{ phones, strategies, attempted: contactIds.length, resolved: Object\.keys\(phones\)\.length \};''',
    '''  const phones: Record<string, string> = {};\n  const strategies: Record<string, string> = {};\n  const pending: Array<{ id: string; wid: unknown }> = [];\n\n  const resolveLocal = async (id: string, wid: unknown, preferredPrefix = ""): Promise<boolean> => {\n    const contact = collectionGet(id, wid);\n    const contactRecord = asRecord(contact);\n    const candidates: Array<[string, unknown]> = [\n      ["contact-phone", contactRecord?.phoneNumber],\n      ["lid-map", call(apiContact, "getPhoneNumber", wid)],\n      ["lid-cache", call(lidPnCache, "getPhoneNumber", wid)],\n      ["lid-cache-entry", get(call(lidPnCache, "getLidEntry", wid), "phoneNumber")],\n      ["alternate-user", call(apiContact, "getAlternateUserWid", wid)],\n      ["latest-mapping", call(apiContact, "getPnIfLidIsLatestMapping", wid)],\n      ["frontend-contact", call(frontendGetters, "getPnForLid", contact)],\n      ["contact-record", call(apiContact, "getContactRecord", wid)],\n      ["store-lid-utils", call(lidUtils, "getPhoneNumber", wid)]\n    ];\n    for (const [strategy, value] of candidates) {\n      const phone = await awaitPhone(value);\n      if (!phone) continue;\n      phones[id] = phone;\n      strategies[id] = preferredPrefix ? `${preferredPrefix}-${strategy}` : strategy;\n      return true;\n    }\n    return false;\n  };\n\n  let localResolved = 0;\n  for (const id of contactIds) {\n    if (!/^\\d{8,20}@lid$/i.test(id)) continue;\n    const wid = call(widFactory, "createWid", id) ?? { _serialized: id, server: "lid" };\n    if (await resolveLocal(id, wid)) localResolved += 1;\n    else pending.push({ id, wid });\n  }\n\n  let serverQueried = 0;\n  let serverResolved = 0;\n  if (querySupported && pending.length) {\n    const batchSize = 4;\n    for (let offset = 0; offset < pending.length; offset += batchSize) {\n      const batch = pending.slice(offset, offset + batchSize);\n      await Promise.all(batch.map(async ({ id, wid }) => {\n        serverQueried += 1;\n        let queryResult: unknown = undefined;\n        try {\n          queryResult = await Promise.resolve(call(queryExistsJob, "queryWidExists", wid));\n        } catch {\n          queryResult = undefined;\n        }\n\n        // Algunas builds devuelven el PN directamente; otras sólo hidratan WAWebApiContact/LidUtils.\n        const direct = phoneFromUnknown(queryResult);\n        if (direct && !/@lid$/i.test(serializedId(queryResult))) {\n          phones[id] = direct;\n          strategies[id] = "query-exists-result";\n          serverResolved += 1;\n          return;\n        }\n        if (await resolveLocal(id, wid, "query-exists")) serverResolved += 1;\n      }));\n      if (offset + batchSize < pending.length) {\n        await new Promise((resolve) => globalThis.setTimeout(resolve, 35));\n      }\n    }\n  }\n\n  return {\n    phones,\n    strategies,\n    attempted: contactIds.length,\n    resolved: Object.keys(phones).length,\n    localResolved,\n    serverQueried,\n    serverResolved,\n    querySupported\n  };''',
    'replace LID resolution loop'
)
text = regex_once(
    text,
    r'''export async function resolveWhatsAppLidsInMainWorld\(tabId: number, contactIds: string\[\]\): Promise<MainWorldLidResolutionBatch> \{.*?\n\}\n\nexport interface ContactHydrationEvidence''',
    '''export async function resolveWhatsAppLidsInMainWorld(tabId: number, contactIds: string[]): Promise<MainWorldLidResolutionBatch> {\n  const unique = [...new Set(contactIds.map((id) => id.trim()).filter((id) => /^\\d{8,20}@lid$/i.test(id)))].slice(0, 1000);\n  const empty = (): MainWorldLidResolutionBatch => ({\n    phones: {}, strategies: {}, attempted: unique.length, resolved: 0,\n    localResolved: 0, serverQueried: 0, serverResolved: 0, querySupported: false\n  });\n  if (!unique.length || !chrome.scripting?.executeScript) return empty();\n  try {\n    const results = await chrome.scripting.executeScript({\n      target: { tabId },\n      world: "MAIN",\n      func: inspectWhatsAppLidsMainWorld,\n      args: [unique]\n    });\n    return results[0]?.result as MainWorldLidResolutionBatch ?? empty();\n  } catch {\n    return empty();\n  }\n}\n\nexport interface ContactHydrationEvidence''',
    'replace chrome LID resolver wrapper'
)
text = replace_once(
    text,
    '''export interface ContactHydrationEvidence {\n  candidates: RawContactCandidate[];\n  hydratedPhones?: Record<string, string>;\n  hydrationPasses?: number;''',
    '''export interface ContactHydrationEvidence {\n  candidates: RawContactCandidate[];\n  hydratedPhones?: Record<string, string>;\n  hydrationPasses?: number;\n  strategy?: "virtualized-lid-hydration" | "server-assisted-lid-map";''',
    'hydration evidence strategy'
)
text = replace_once(
    text,
    '''export function mergeHydratedPhonesIntoCollection(\n  structured: ContactExportCollectionResult,\n  evidence: ContactHydrationEvidence\n): ContactHydrationMergeResult {\n  const allowedIds''',
    '''export function mergeHydratedPhonesIntoCollection(\n  structured: ContactExportCollectionResult,\n  evidence: ContactHydrationEvidence\n): ContactHydrationMergeResult {\n  const hydrationStrategy = evidence.strategy ?? "virtualized-lid-hydration";\n  const allowedIds''',
    'merge strategy variable'
)
text = text.replace('strategy: `${candidate.strategy}+virtualized-lid-hydration`', 'strategy: `${candidate.strategy}+${hydrationStrategy}`')
text = text.replace('scopeStrategy: "main-world-label-store+virtualized-lid-hydration"', 'scopeStrategy: `main-world-label-store+${hydrationStrategy}`')
text = text.replace('strategy: "main-world-label-store+virtualized-lid-hydration",\n      labelResults,', 'strategy: `main-world-label-store+${hydrationStrategy}`,\n      labelResults,')
write(path, text)

# --- Runtime: never use the visual label viewport when structured membership is already available.
path = 'src/background/contact-export-runtime.ts'
text = read(path)
text = replace_once(
    text,
    'import { collectContactsFromWhatsAppMainWorld, mergeHydratedPhonesIntoCollection } from "../contact-export/whatsapp-main-world-resolver";',
    'import { collectContactsFromWhatsAppMainWorld, mergeHydratedPhonesIntoCollection, resolveWhatsAppLidsInMainWorld } from "../contact-export/whatsapp-main-world-resolver";',
    'runtime resolver import'
)
text = replace_once(
    text,
    '''  "resolvedPhones",\n  "unresolvedPhones"''',
    '''  "resolvedPhones",\n  "unresolvedPhones",\n  "phoneLookupAttempted",\n  "phoneLookupLocalResolved",\n  "phoneLookupServerQueried",\n  "phoneLookupServerResolved",\n  "phoneLookupRemaining",\n  "phoneLookupQuerySupported",\n  "visualHydrationUsed"''',
    'technical detail allowlist'
)
text = regex_once(
    text,
    r'''      let hydrationStats = \{ attempted: 0, resolved: 0, remaining: 0, passes: 0 \};\n      let structuredResult = structured;\n      if \(structured\) \{.*?\n      \}\n      const result = structuredResult''',
    '''      let resolutionStats = {\n        attempted: 0, localResolved: 0, serverQueried: 0, serverResolved: 0,\n        remaining: 0, querySupported: false\n      };\n      let structuredResult = structured;\n      if (structured) {\n        const unresolvedLids = structured.candidates\n          .filter((candidate) => candidate.phoneStatus !== "resolved" && /^\\d{8,20}@lid$/i.test(candidate.contactId ?? ""))\n          .map((candidate) => candidate.contactId!)\n          .filter((id, index, all) => all.indexOf(id) === index);\n\n        if (unresolvedLids.length) {\n          const batch = await resolveWhatsAppLidsInMainWorld(tab.id, unresolvedLids);\n          const merged = mergeHydratedPhonesIntoCollection(structured, {\n            candidates: [],\n            hydratedPhones: batch.phones,\n            hydrationPasses: batch.serverQueried > 0 ? 2 : 1,\n            strategy: "server-assisted-lid-map"\n          });\n          structuredResult = merged.collection;\n          resolutionStats = {\n            attempted: unresolvedLids.length,\n            localResolved: batch.localResolved,\n            serverQueried: batch.serverQueried,\n            serverResolved: batch.serverResolved,\n            remaining: merged.remaining,\n            querySupported: batch.querySupported\n          };\n        }\n\n        const completedStructured = structuredResult ?? structured;\n        await this.recordProgress({\n          operationId,\n          processed: completedStructured.candidates.length,\n          totalHint: completedStructured.labelResults.reduce((sum, item) => sum + (item.reportedCount ?? item.collectedUniqueContacts), 0) || null,\n          percent: 100,\n          currentLabel: labels.at(-1)?.name ?? null,\n          labelIndex: labels.length,\n          totalLabels: labels.length,\n          currentContact: completedStructured.candidates.length,\n          metrics: completedStructured.metrics,\n          labelResults: completedStructured.labelResults\n        });\n      }\n      const result = structuredResult''',
    'runtime structured resolution block'
)
text = replace_once(
    text,
    '''          lastSuccessfulStep: hydrationStats.attempted > 0\n            ? "virtualized_lid_phone_hydration_completed"\n            : "label_scoped_phone_first_analysis_completed",''',
    '''          lastSuccessfulStep: resolutionStats.attempted > 0\n            ? "nonvisual_lid_phone_resolution_completed"\n            : "label_scoped_phone_first_analysis_completed",''',
    'runtime success step'
)
text = regex_once(
    text,
    r'''          technicalDetails: hydrationStats\.attempted > 0 \? \{\n            phoneHydrationAttempted: hydrationStats\.attempted,\n            phoneHydrationResolved: hydrationStats\.resolved,\n            phoneHydrationRemaining: hydrationStats\.remaining,\n            phoneHydrationPasses: hydrationStats\.passes\n          \} : \{},''',
    '''          technicalDetails: resolutionStats.attempted > 0 ? {\n            phoneLookupAttempted: resolutionStats.attempted,\n            phoneLookupLocalResolved: resolutionStats.localResolved,\n            phoneLookupServerQueried: resolutionStats.serverQueried,\n            phoneLookupServerResolved: resolutionStats.serverResolved,\n            phoneLookupRemaining: resolutionStats.remaining,\n            phoneLookupQuerySupported: resolutionStats.querySupported,\n            visualHydrationUsed: false\n          } : {},''',
    'runtime diagnostic details'
)
write(path, text)

# --- Tests: prove server-assisted reverse mapping works without any DOM/chat/scroll.
path = 'tests/contact-export-hydration.test.ts'
text = read(path)
addition = r'''

describe("Contact Export nonvisual LID resolution", () => {
  it("queries WhatsApp internally for a LID and re-reads the hydrated PN without opening a chat", async () => {
    const lid = "123456789012345@lid";
    let hydrated = false;
    Object.defineProperty(window, "require", {
      configurable: true,
      value: (moduleName: string) => {
        if (moduleName === "WAWebWidFactory") return { createWid: (id: string) => ({ _serialized: id, server: "lid" }) };
        if (moduleName === "WAWebApiContact") return {
          getPhoneNumber: () => hydrated ? { _serialized: "5491123456789@c.us", server: "c.us" } : undefined,
          lidPnCache: { getPhoneNumber: () => undefined, getLidEntry: () => undefined }
        };
        if (moduleName === "WAWebCollections") return { Contact: { get: () => undefined } };
        if (moduleName === "WAWebQueryExistsJob") return {
          queryWidExists: async () => {
            hydrated = true;
            return { wid: { _serialized: lid, server: "lid" } };
          }
        };
        return {};
      }
    });
    const result = await inspectWhatsAppLidsMainWorld([lid]);
    expect(result).toMatchObject({
      attempted: 1,
      resolved: 1,
      localResolved: 0,
      serverQueried: 1,
      serverResolved: 1,
      querySupported: true
    });
    expect(result.phones[lid]).toBe("5491123456789@c.us");
    expect(result.strategies[lid]).toContain("query-exists");
    expect(document.querySelector("#main")).toBeNull();
  });

  it("resolves 210 structured LIDs through the internal query path with no visual rows or scroll", async () => {
    const ids = Array.from({ length: 210 }, (_, index) => `${String(800000000000000 + index)}@lid`);
    const phoneByLid = new Map<string, string>();
    Object.defineProperty(window, "require", {
      configurable: true,
      value: (moduleName: string) => {
        if (moduleName === "WAWebWidFactory") return { createWid: (id: string) => ({ _serialized: id, server: "lid" }) };
        if (moduleName === "WAWebApiContact") return {
          getPhoneNumber: (wid: { _serialized?: string }) => {
            const phone = phoneByLid.get(String(wid?._serialized || ""));
            return phone ? { _serialized: phone, server: "c.us" } : undefined;
          },
          lidPnCache: { getPhoneNumber: () => undefined, getLidEntry: () => undefined }
        };
        if (moduleName === "WAWebCollections") return { Contact: { get: () => undefined } };
        if (moduleName === "WAWebQueryExistsJob") return {
          queryWidExists: async (wid: { _serialized?: string }) => {
            const id = String(wid?._serialized || "");
            const index = ids.indexOf(id);
            if (index >= 0) phoneByLid.set(id, `${5491100000000 + index}@c.us`);
            return { wid };
          }
        };
        return {};
      }
    });
    const result = await inspectWhatsAppLidsMainWorld(ids);
    expect(result.attempted).toBe(210);
    expect(result.resolved).toBe(210);
    expect(result.localResolved).toBe(0);
    expect(result.serverQueried).toBe(210);
    expect(result.serverResolved).toBe(210);
    expect(Object.keys(result.phones)).toHaveLength(210);
    expect(document.querySelectorAll("[role='listitem']")).toHaveLength(0);
  });
});
'''
text += addition
write(path, text)

# --- Release metadata.
for metadata_path in ['manifest.json', 'package.json']:
    data = json.loads(read(metadata_path))
    data['version'] = '0.9.5.5'
    if metadata_path == 'manifest.json':
        data['version_name'] = '0.9.5.5'
    write(metadata_path, json.dumps(data, ensure_ascii=False, indent=2) + '\n')

lock = json.loads(read('package-lock.json'))
lock['version'] = '0.9.5.5'
if '' in lock.get('packages', {}):
    lock['packages']['']['version'] = '0.9.5.5'
write('package-lock.json', json.dumps(lock, ensure_ascii=False, indent=2) + '\n')

path = 'scripts/validate-build.mjs'
text = read(path)
text = text.replace('0.9.5.4', '0.9.5.5')
needle = '''if (!backgroundWorker.includes("WAWebCollections") || !backgroundWorker.includes("WAWebApiContact") || !backgroundWorker.includes("main-world-label-store+local-lid-map")) {\n  throw new Error("El build no contiene el resolver estructurado local de etiquetas/LID de 0.9.5.3.");\n}\n'''
if needle not in text:
    raise RuntimeError('validate-build background resolver guard not found')
text = text.replace(needle, needle + '''if (!backgroundWorker.includes("WAWebQueryExistsJob") || !backgroundWorker.includes("server-assisted-lid-map")) {\n  throw new Error("El build no contiene el resolver no visual LID→PN asistido por consulta interna de 0.9.5.5.");\n}\n''')
write(path, text)

readme = read('README.md')
release_note = '''\n\n### 0.9.5.5 — resolución no visual LID → teléfono\n\nCuando la membresía estructurada de una etiqueta contiene LID cuyo PN no está en cache, Contact Export ya no intenta depender del viewport ni del scroll. Primero consulta todos los stores locales y, para los LID todavía pendientes, usa la operación interna de WhatsApp Web `WAWebQueryExistsJob.queryWidExists` y vuelve a leer `WAWebApiContact`/LidUtils. No abre chats ni lee mensajes. Los teléfonos sólo se fusionan si el `contactId` pertenece a la membresía estructurada original de la etiqueta.\n'''
if '### 0.9.5.5 — resolución no visual LID → teléfono' not in readme:
    readme += release_note
write('README.md', readme)

doc = read('docs/whatsapp-contact-export.md')
section = '''\n\n## Resolución no visual de LID en 0.9.5.5\n\nUna etiqueta puede conservar cientos de miembros estructurados aunque WhatsApp Web sólo muestre unos pocos chats. En ese caso el extractor usa `labelItemCollection` como membresía autoritativa y evita usar el DOM para descubrir contactos. Para cada `@lid` sin PN, consulta primero cache/colecciones locales y luego, si la build lo expone, `WAWebQueryExistsJob.queryWidExists`. Esa consulta no abre la conversación: permite que WhatsApp refresque su mapeo interno y luego se vuelve a consultar `WAWebApiContact.getPhoneNumber`, `lidPnCache`, `LidUtils` y las fuentes locales ya soportadas.\n\nEl resolver trabaja en lotes pequeños, no envía mensajes y no incorpora un número si no puede correlacionarlo exactamente con uno de los IDs estructurados de la etiqueta. Si WhatsApp no devuelve PN aun después de la consulta, el contacto permanece `PHONE_UNRESOLVED`; no se inventa ni se infiere el número.\n'''
if '## Resolución no visual de LID en 0.9.5.5' not in doc:
    doc += section
write('docs/whatsapp-contact-export.md', doc)

release = '''# Contact Export 0.9.5.5\n\n## Incidente confirmado\n\nEl diagnóstico real de 0.9.5.4 encontró 210/210 miembros estructurados en `Wh-Junio/Julio15-2025`, pero sólo 18 PN. La hidratación visual intentó 192 LID durante tres pasadas y resolvió 0; por lo tanto el viewport no era la fuente del mapeo faltante.\n\n## Cambio\n\n- Se elimina la dependencia del scroll para completar PN cuando ya existe membresía estructurada.\n- El resolver intenta primero todas las fuentes locales LID↔PN.\n- Los LID pendientes se consultan con `WAWebQueryExistsJob.queryWidExists` en lotes de cuatro y luego se revalida el cache local.\n- No se abre ningún chat ni se leen mensajes.\n- La fusión continúa fail-closed: sólo acepta PN para un `contactId` presente en la membresía estructurada original.\n- El diagnóstico separa `phoneLookupLocalResolved`, `phoneLookupServerQueried`, `phoneLookupServerResolved` y `phoneLookupRemaining`.\n\n## Límite real\n\nSi WhatsApp no revela un PN para un LID ni siquiera después de su propia consulta interna, el extractor lo deja `PHONE_UNRESOLVED`. Esto puede ocurrir por privacidad o porque el servidor no entrega una asociación PN para ese LID.\n'''
write('docs/contact-export-release-notes-0.9.5.5.md', release)

print('Applied Contact Export 0.9.5.5 nonvisual LID resolution patch')
