from pathlib import Path
import json

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


def replace_block(content: str, start: str, end: str, replacement: str, label: str) -> str:
    start_index = content.find(start)
    end_index = content.find(end, start_index + len(start))
    if start_index < 0 or end_index < 0:
        raise RuntimeError(f'{label}: block markers not found')
    return content[:start_index] + replacement + content[end_index:]


# --- MAIN world resolver: replace the unsuccessful LID->server lookup with
# deterministic metadata/history correlation. No chat opening and no message text.
path = 'src/contact-export/whatsapp-main-world-resolver.ts'
text = read(path)
text = replace_once(
    text,
    '''export interface MainWorldLidResolutionBatch {\n  phones: Record<string, string>;\n  strategies: Record<string, string>;\n  attempted: number;\n  resolved: number;\n  localResolved: number;\n  serverQueried: number;\n  serverResolved: number;\n  querySupported: boolean;\n}''',
    '''export interface MainWorldLidResolutionBatch {\n  phones: Record<string, string>;\n  strategies: Record<string, string>;\n  attempted: number;\n  resolved: number;\n  localResolved: number;\n  serverQueried: number;\n  serverResolved: number;\n  querySupported: boolean;\n  historyResolved: number;\n  historyMessagesScanned: number;\n  historyChatsPresent: number;\n  historyConflicts: number;\n}''',
    'MainWorldLidResolutionBatch interface'
)

start = 'export async function inspectWhatsAppLidsMainWorld(contactIds: string[]): Promise<MainWorldLidResolutionBatch> {'
end = 'export async function resolveWhatsAppLidsInMainWorld(tabId: number, contactIds: string[]): Promise<MainWorldLidResolutionBatch> {'
replacement = r'''export async function inspectWhatsAppLidsMainWorld(contactIds: string[]): Promise<MainWorldLidResolutionBatch> {
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
    const direct = [record._serialized, record.serialized].find((item) => typeof item === "string" && item.trim());
    if (typeof direct === "string") return direct.trim();
    if (typeof record.id === "string" && record.id.trim()) return record.id.trim();
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
    for (const key of ["phoneNumber", "pn", "pnJid", "phone", "wid", "id", "alternateUserWid", "alternateWid", "remoteJidAlt", "participantPn", "senderPn"]) {
      const phone = pnJid(record[key]);
      if (phone) return phone;
    }
    return null;
  };
  const listFrom = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value;
    const models = call(value, "getModelsArray");
    return Array.isArray(models) ? models : [];
  };
  const globalWindow = window as unknown as { require?: (name: string) => unknown; Store?: unknown };
  const requireFn = globalWindow.require;
  const empty: MainWorldLidResolutionBatch = {
    phones: {}, strategies: {}, attempted: contactIds.length, resolved: 0,
    localResolved: 0, serverQueried: 0, serverResolved: 0, querySupported: false,
    historyResolved: 0, historyMessagesScanned: 0, historyChatsPresent: 0, historyConflicts: 0
  };
  if (typeof requireFn !== "function") return empty;
  const safeRequire = (name: string): unknown => { try { return requireFn(name); } catch { return undefined; } };
  const widFactory = safeRequire("WAWebWidFactory");
  const apiContact = safeRequire("WAWebApiContact");
  const apiRecord = asRecord(apiContact);
  const lidPnCache = apiRecord?.lidPnCache;
  const collections = asRecord(safeRequire("WAWebCollections"));
  const contactCollection = collections?.Contact;
  const chatCollection = collections?.Chat;
  const msgCollection = collections?.Msg;
  const labelCollection = collections?.Label;
  const frontendGetters = safeRequire("WAWebFrontendContactGetters");
  const lidUtils = asRecord(globalWindow.Store)?.LidUtils;
  const queryExistsJob = safeRequire("WAWebQueryExistsJob");
  const querySupported = typeof get(queryExistsJob, "queryWidExists") === "function";

  const collectionGet = (collection: unknown, id: string, wid: unknown): unknown => call(collection, "get", wid) ?? call(collection, "get", id);
  const awaitPhone = async (value: unknown): Promise<string | null> => {
    if (value === undefined || value === null) return null;
    try { return phoneFromUnknown(await Promise.resolve(value)); } catch { return null; }
  };

  const phones: Record<string, string> = {};
  const strategies: Record<string, string> = {};
  const pending: Array<{ id: string; wid: unknown }> = [];

  const resolveLocal = async (id: string, wid: unknown): Promise<boolean> => {
    const contact = collectionGet(contactCollection, id, wid);
    const contactRecord = asRecord(contact);
    const candidates: Array<[string, unknown]> = [
      ["contact-phone", contactRecord?.phoneNumber],
      ["contact-pn-jid", contactRecord?.pnJid],
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
      return true;
    }
    return false;
  };

  let localResolved = 0;
  for (const id of contactIds) {
    if (!/^\d{8,20}@lid$/i.test(id)) continue;
    const wid = call(widFactory, "createWid", id) ?? { _serialized: id, server: "lid" };
    if (await resolveLocal(id, wid)) localResolved += 1;
    else pending.push({ id, wid });
  }

  // queryWidExists is intentionally NOT called for LID -> PN in 0.9.5.6.
  // Current WA-JS resolves an existing LID to PN from the local lidPnCache;
  // server lookup is used in the opposite PN -> LID direction. 0.9.5.5 proved
  // that 192 LID queries completed with zero new mappings on the real account.
  const serverQueried = 0;
  const serverResolved = 0;

  const targetIds = new Set(pending.filter(({ id }) => !phones[id]).map(({ id }) => id.toLowerCase()));
  const historyCandidates = new Map<string, Map<string, Set<string>>>();
  let historyMessagesScanned = 0;
  let historyChatsPresent = 0;

  const addHistoryCandidate = (rawId: unknown, rawPhone: unknown, source: string): void => {
    const id = serializedId(rawId).toLowerCase();
    if (!targetIds.has(id)) return;
    const phone = phoneFromUnknown(rawPhone);
    if (!phone) return;
    let byPhone = historyCandidates.get(id);
    if (!byPhone) {
      byPhone = new Map<string, Set<string>>();
      historyCandidates.set(id, byPhone);
    }
    let sources = byPhone.get(phone);
    if (!sources) {
      sources = new Set<string>();
      byPhone.set(phone, sources);
    }
    sources.add(source);
  };

  const scanMessageMetadata = (message: unknown): void => {
    const record = asRecord(message);
    if (!record) return;
    historyMessagesScanned += 1;
    const key = asRecord(record.id) ?? asRecord(record.key);
    const remote = key?.remote ?? key?.remoteJid ?? record.remoteJid;
    const remoteId = serializedId(remote).toLowerCase();
    if (targetIds.has(remoteId)) {
      for (const [source, value] of [
        ["message-remote-alt", key?.remoteJidAlt],
        ["message-remote-alt", record.remoteJidAlt],
        ["message-pn-jid", record.pnJid],
        ["message-peer-pn", record.peerPn]
      ] as Array<[string, unknown]>) addHistoryCandidate(remoteId, value, source);

      const fromMe = Boolean(key?.fromMe ?? record.fromMe);
      if (fromMe) {
        const receipts = listFrom(record.userReceipt);
        for (const receipt of receipts) {
          addHistoryCandidate(remoteId, asRecord(receipt)?.userJid, "message-user-receipt");
        }
      }
    }

    const participant = key?.participant ?? record.participant;
    const participantId = serializedId(participant).toLowerCase();
    if (targetIds.has(participantId)) {
      addHistoryCandidate(participantId, key?.participantPn, "message-participant-pn");
      addHistoryCandidate(participantId, record.participantPn, "message-participant-pn");
      addHistoryCandidate(participantId, key?.participantAlt, "message-participant-alt");
      addHistoryCandidate(participantId, record.participantAlt, "message-participant-alt");
    }

    const sender = key?.sender ?? record.sender ?? record.author ?? record.from;
    const senderId = serializedId(sender).toLowerCase();
    if (targetIds.has(senderId)) {
      addHistoryCandidate(senderId, key?.senderPn, "message-sender-pn");
      addHistoryCandidate(senderId, record.senderPn, "message-sender-pn");
      addHistoryCandidate(senderId, record.authorPn, "message-author-pn");
    }

    const to = record.to;
    const toId = serializedId(to).toLowerCase();
    if (targetIds.has(toId)) addHistoryCandidate(toId, record.toAlt ?? record.recipientPn, "message-recipient-alt");
  };

  // 1) Label-item metadata: some builds keep the alternate PN beside parentId.
  for (const label of listFrom(labelCollection)) {
    const items = listFrom(asRecord(label)?.labelItemCollection);
    for (const item of items) {
      const record = asRecord(item);
      const parentId = record?.parentId;
      const id = serializedId(parentId).toLowerCase();
      if (!targetIds.has(id)) continue;
      for (const [source, value] of [
        ["label-parent-alt", record?.parentIdAlt],
        ["label-pn-jid", record?.pnJid],
        ["label-phone", record?.phoneNumber],
        ["label-parent-pn", record?.parentPn]
      ] as Array<[string, unknown]>) addHistoryCandidate(id, value, source);
    }
  }

  // 2) Chat/contact metadata and already-loaded message metadata for each exact LID.
  for (const { id, wid } of pending) {
    if (phones[id]) continue;
    const chat = collectionGet(chatCollection, id, wid);
    if (!chat) continue;
    historyChatsPresent += 1;
    const chatRecord = asRecord(chat);
    addHistoryCandidate(id, chatRecord?.pnJid, "chat-pn-jid");
    addHistoryCandidate(id, chatRecord?.phoneNumber, "chat-phone");
    addHistoryCandidate(id, chatRecord?.remoteJidAlt, "chat-remote-alt");
    addHistoryCandidate(id, chatRecord?.alternateUserWid, "chat-alternate-user");
    const contact = chatRecord?.contact ?? collectionGet(contactCollection, id, wid);
    const contactRecord = asRecord(contact);
    addHistoryCandidate(id, contactRecord?.pnJid, "contact-pn-jid");
    addHistoryCandidate(id, contactRecord?.phoneNumber, "contact-phone");
    addHistoryCandidate(id, contactRecord?.alternateUserWid, "contact-alternate-user");
    for (const message of listFrom(chatRecord?.msgs ?? chatRecord?.messages)) scanMessageMetadata(message);
  }

  // 3) Global already-synchronised message models. Only addressing/receipt metadata is
  // inspected; message bodies/media/content are never read or persisted.
  const globalMessages = listFrom(msgCollection);
  const maxMessages = 100000;
  const startAt = Math.max(0, globalMessages.length - maxMessages);
  for (let index = startAt; index < globalMessages.length; index += 1) scanMessageMetadata(globalMessages[index]);

  let historyResolved = 0;
  let historyConflicts = 0;
  for (const { id } of pending) {
    if (phones[id]) continue;
    const byPhone = historyCandidates.get(id.toLowerCase());
    if (!byPhone?.size) continue;
    if (byPhone.size !== 1) {
      historyConflicts += 1;
      continue;
    }
    const [phone, sources] = [...byPhone.entries()][0];
    phones[id] = phone;
    strategies[id] = `history-${[...sources].sort().join("+")}`;
    historyResolved += 1;
  }

  return {
    phones,
    strategies,
    attempted: contactIds.length,
    resolved: Object.keys(phones).length,
    localResolved,
    serverQueried,
    serverResolved,
    querySupported,
    historyResolved,
    historyMessagesScanned,
    historyChatsPresent,
    historyConflicts
  };
}

'''
text = replace_block(text, start, end, replacement, 'replace LID resolver')
text = replace_once(
    text,
    '''  const empty = (): MainWorldLidResolutionBatch => ({\n    phones: {}, strategies: {}, attempted: unique.length, resolved: 0,\n    localResolved: 0, serverQueried: 0, serverResolved: 0, querySupported: false\n  });''',
    '''  const empty = (): MainWorldLidResolutionBatch => ({\n    phones: {}, strategies: {}, attempted: unique.length, resolved: 0,\n    localResolved: 0, serverQueried: 0, serverResolved: 0, querySupported: false,\n    historyResolved: 0, historyMessagesScanned: 0, historyChatsPresent: 0, historyConflicts: 0\n  });''',
    'wrapper empty batch'
)
text = replace_once(
    text,
    'strategy?: "virtualized-lid-hydration" | "server-assisted-lid-map";',
    'strategy?: "virtualized-lid-hydration" | "server-assisted-lid-map" | "history-metadata-lid-map";',
    'hydration strategy union'
)
write(path, text)


# --- Runtime diagnostics: expose exactly what the history correlation recovered.
path = 'src/background/contact-export-runtime.ts'
text = read(path)
text = replace_once(
    text,
    '''  "phoneLookupQuerySupported",\n  "visualHydrationUsed"''',
    '''  "phoneLookupQuerySupported",\n  "phoneLookupMethod",\n  "phoneLookupServerSkipped",\n  "phoneHistoryResolved",\n  "phoneHistoryMessagesScanned",\n  "phoneHistoryChatsPresent",\n  "phoneHistoryConflicts",\n  "visualHydrationUsed"''',
    'diagnostic allowlist'
)
text = replace_once(
    text,
    '''      let resolutionStats = {\n        attempted: 0, localResolved: 0, serverQueried: 0, serverResolved: 0,\n        remaining: 0, querySupported: false\n      };''',
    '''      let resolutionStats = {\n        attempted: 0, localResolved: 0, serverQueried: 0, serverResolved: 0,\n        remaining: 0, querySupported: false, historyResolved: 0,\n        historyMessagesScanned: 0, historyChatsPresent: 0, historyConflicts: 0\n      };''',
    'runtime resolutionStats'
)
text = replace_once(
    text,
    '''            hydrationPasses: batch.serverQueried > 0 ? 2 : 1,\n            strategy: "server-assisted-lid-map"''',
    '''            hydrationPasses: batch.historyMessagesScanned > 0 ? 2 : 1,\n            strategy: "history-metadata-lid-map"''',
    'runtime merge strategy'
)
text = replace_once(
    text,
    '''            serverResolved: batch.serverResolved,\n            remaining: merged.remaining,\n            querySupported: batch.querySupported\n          };''',
    '''            serverResolved: batch.serverResolved,\n            remaining: merged.remaining,\n            querySupported: batch.querySupported,\n            historyResolved: batch.historyResolved,\n            historyMessagesScanned: batch.historyMessagesScanned,\n            historyChatsPresent: batch.historyChatsPresent,\n            historyConflicts: batch.historyConflicts\n          };''',
    'runtime batch stats'
)
text = replace_once(
    text,
    '? "nonvisual_lid_phone_resolution_completed"',
    '? "history_metadata_lid_resolution_completed"',
    'runtime success step'
)
text = replace_once(
    text,
    '''            phoneLookupServerResolved: resolutionStats.serverResolved,\n            phoneLookupRemaining: resolutionStats.remaining,\n            phoneLookupQuerySupported: resolutionStats.querySupported,\n            visualHydrationUsed: false''',
    '''            phoneLookupServerResolved: resolutionStats.serverResolved,\n            phoneLookupRemaining: resolutionStats.remaining,\n            phoneLookupQuerySupported: resolutionStats.querySupported,\n            phoneLookupMethod: "history-metadata",\n            phoneLookupServerSkipped: true,\n            phoneHistoryResolved: resolutionStats.historyResolved,\n            phoneHistoryMessagesScanned: resolutionStats.historyMessagesScanned,\n            phoneHistoryChatsPresent: resolutionStats.historyChatsPresent,\n            phoneHistoryConflicts: resolutionStats.historyConflicts,\n            visualHydrationUsed: false''',
    'runtime technical details'
)
write(path, text)


# --- Tests: replace the queryWidExists assumption with strong history metadata tests.
path = 'tests/contact-export-hydration.test.ts'
text = read(path)
marker = 'describe("Contact Export nonvisual LID resolution", () => {'
index = text.find(marker)
if index < 0:
    raise RuntimeError('history tests: old nonvisual describe not found')
text = text[:index] + r'''describe("Contact Export historical LID resolution", () => {
  it("resolves 210 structured LIDs from outgoing history receipts with no visual rows, scroll or server lookup", async () => {
    const ids = Array.from({ length: 210 }, (_, index) => `${String(800000000000000 + index)}@lid`);
    const chats = new Map<string, unknown>();
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      chats.set(id, {
        id: { _serialized: id },
        msgs: {
          getModelsArray: () => [{
            id: { remote: { _serialized: id }, fromMe: true },
            userReceipt: [{ userJid: { _serialized: `${5491100000000 + index}@c.us` } }]
          }]
        }
      });
    }
    let serverCalls = 0;
    Object.defineProperty(window, "require", {
      configurable: true,
      value: (moduleName: string) => {
        if (moduleName === "WAWebWidFactory") return { createWid: (id: string) => ({ _serialized: id, server: "lid" }) };
        if (moduleName === "WAWebApiContact") return {
          getPhoneNumber: () => undefined,
          lidPnCache: { getPhoneNumber: () => undefined, getLidEntry: () => undefined }
        };
        if (moduleName === "WAWebCollections") return {
          Contact: { get: () => undefined },
          Chat: { get: (wid: { _serialized?: string } | string) => chats.get(typeof wid === "string" ? wid : String(wid?._serialized || "")) },
          Msg: { getModelsArray: () => [] },
          Label: { getModelsArray: () => [] }
        };
        if (moduleName === "WAWebQueryExistsJob") return {
          queryWidExists: async () => { serverCalls += 1; return undefined; }
        };
        return {};
      }
    });

    const result = await inspectWhatsAppLidsMainWorld(ids);
    expect(result.attempted).toBe(210);
    expect(result.resolved).toBe(210);
    expect(result.localResolved).toBe(0);
    expect(result.serverQueried).toBe(0);
    expect(result.serverResolved).toBe(0);
    expect(serverCalls).toBe(0);
    expect(result.historyResolved).toBe(210);
    expect(result.historyChatsPresent).toBe(210);
    expect(result.historyMessagesScanned).toBeGreaterThanOrEqual(210);
    expect(result.historyConflicts).toBe(0);
    expect(Object.keys(result.phones)).toHaveLength(210);
    expect(document.querySelectorAll("[role='listitem']")).toHaveLength(0);
  });

  it("fails closed when historical metadata gives two different phone numbers for the same LID", async () => {
    const lid = "123456789012345@lid";
    Object.defineProperty(window, "require", {
      configurable: true,
      value: (moduleName: string) => {
        if (moduleName === "WAWebWidFactory") return { createWid: (id: string) => ({ _serialized: id, server: "lid" }) };
        if (moduleName === "WAWebApiContact") return {
          getPhoneNumber: () => undefined,
          lidPnCache: { getPhoneNumber: () => undefined, getLidEntry: () => undefined }
        };
        if (moduleName === "WAWebCollections") return {
          Contact: { get: () => undefined },
          Chat: {
            get: () => ({
              id: { _serialized: lid },
              msgs: {
                getModelsArray: () => [
                  { id: { remote: { _serialized: lid }, fromMe: true }, userReceipt: [{ userJid: { _serialized: "5491123456789@c.us" } }] },
                  { id: { remote: { _serialized: lid }, fromMe: true }, userReceipt: [{ userJid: { _serialized: "5491199999999@c.us" } }] }
                ]
              }
            })
          },
          Msg: { getModelsArray: () => [] },
          Label: { getModelsArray: () => [] }
        };
        return {};
      }
    });

    const result = await inspectWhatsAppLidsMainWorld([lid]);
    expect(result.resolved).toBe(0);
    expect(result.historyResolved).toBe(0);
    expect(result.historyConflicts).toBe(1);
    expect(result.phones[lid]).toBeUndefined();
  });
});
'''
write(path, text)


# --- Release metadata.
manifest_path = ROOT / 'manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['version'] = '0.9.5.6'
manifest['version_name'] = '0.9.5.6'
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

package_path = ROOT / 'package.json'
package = json.loads(package_path.read_text(encoding='utf-8'))
package['version'] = '0.9.5.6'
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

lock_path = ROOT / 'package-lock.json'
lock = json.loads(lock_path.read_text(encoding='utf-8'))
lock['version'] = '0.9.5.6'
lock.setdefault('packages', {}).setdefault('', {})['version'] = '0.9.5.6'
lock_path.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

path = 'scripts/validate-build.mjs'
text = read(path)
text = text.replace('0.9.5.5', '0.9.5.6')
text = replace_once(
    text,
    '''if (!backgroundWorker.includes("WAWebQueryExistsJob") || !backgroundWorker.includes("server-assisted-lid-map")) {\n  throw new Error("El build no contiene el resolver no visual LID→PN asistido por consulta interna de 0.9.5.6.");\n}''',
    '''if (!backgroundWorker.includes("message-user-receipt") || !backgroundWorker.includes("history-metadata-lid-map") || !backgroundWorker.includes("phoneLookupServerSkipped")) {\n  throw new Error("El build no contiene la correlación histórica LID→PN no visual de 0.9.5.6.");\n}''',
    'validate-build history marker'
)
write(path, text)


# --- Documentation.
release_notes = '''# Contact Export 0.9.5.6 — correlación histórica LID → teléfono\n\n## Evidencia real que obliga al cambio\n\nLa prueba real de 0.9.5.5 sobre `Wh-Junio/Julio15-2025` encontró 210 miembros estructurados y 18 teléfonos. Para los 192 LID restantes ejecutó 192 intentos de `queryWidExists`, con `serverResolved: 0`, `remaining: 192`, 0 scrolls y 0 chats abiertos.\n\nEsto demuestra que el problema no es el viewport: WhatsApp conserva la membresía de la etiqueta, pero no expone un PN para esos LID mediante esa consulta.\n\n## Cambio de metodología\n\n0.9.5.6 deja de ejecutar `queryWidExists` para LID → PN. En su lugar, después del cache local correlaciona únicamente evidencia fuerte ya sincronizada por WhatsApp:\n\n- metadata alternativa del item de etiqueta;\n- metadata del Chat/Contact exacto para ese LID;\n- `remoteJidAlt`;\n- `participantPn` / `participantAlt`;\n- `senderPn`;\n- `userReceipt.userJid` de mensajes salientes del chat LID;\n- modelos de mensajes ya cargados/sincronizados.\n\nNo se inspecciona texto, contenido ni media de los mensajes. No se abre ningún chat y no se hace scroll.\n\n## Fail closed\n\nUn teléfono sólo se acepta cuando está ligado al LID exacto por una de esas relaciones. Si dos evidencias históricas producen teléfonos distintos para un mismo LID, el contacto queda `PHONE_UNRESOLVED`; no se elige uno por heurística.\n\n## Diagnóstico nuevo\n\n- `phoneLookupMethod: history-metadata`\n- `phoneLookupServerSkipped: true`\n- `phoneHistoryResolved`\n- `phoneHistoryMessagesScanned`\n- `phoneHistoryChatsPresent`\n- `phoneHistoryConflicts`\n\n## Límite real\n\nSi WhatsApp nunca sincronizó un PN para un LID histórico, ningún algoritmo local puede reconstruir ese número a partir de los dígitos del LID. En ese caso se necesita una fuente externa/previa del mapping o esperar una futura interacción que vuelva a incluir PN metadata.\n'''
write('docs/contact-export-release-notes-0.9.5.6.md', release_notes)

path = 'docs/whatsapp-contact-export.md'
text = read(path)
appendix = '''\n\n## 0.9.5.6 — correlación histórica no visual\n\nLa extracción de membresía continúa usando `labelItemCollection`. Para LID sin PN local, 0.9.5.6 ya no intenta forzar `queryWidExists(LID)`: correlaciona metadata histórica fuerte del mismo LID (`remoteJidAlt`, PN alternativo de participante/remitente y `userReceipt` de mensajes salientes). La inspección se limita a addressing/receipt metadata; no lee ni persiste el cuerpo de mensajes. Conflictos de mapping quedan sin resolver.\n'''
if '## 0.9.5.6 — correlación histórica no visual' not in text:
    text += appendix
write(path, text)

print('Applied Contact Export 0.9.5.6 history-metadata LID resolution patch')
