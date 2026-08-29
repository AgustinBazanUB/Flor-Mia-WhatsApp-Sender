from pathlib import Path

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

# Resolver metadata + direct IndexedDB history scan.
path = 'src/contact-export/whatsapp-main-world-resolver.ts'
text = read(path)
text = replace_once(
    text,
    '''  historyChatsPresent: number;\n  historyConflicts: number;\n}''',
    '''  historyChatsPresent: number;\n  historyConflicts: number;\n  historyIndexedDbSupported: boolean;\n  historyIndexedDbMessagesScanned: number;\n  historyIndexedDbError: boolean;\n}''',
    'batch IndexedDB fields'
)
text = text.replace(
    'historyResolved: 0, historyMessagesScanned: 0, historyChatsPresent: 0, historyConflicts: 0',
    'historyResolved: 0, historyMessagesScanned: 0, historyChatsPresent: 0, historyConflicts: 0,\n    historyIndexedDbSupported: false, historyIndexedDbMessagesScanned: 0, historyIndexedDbError: false'
)
text = replace_once(
    text,
    '''    if (targetIds.has(senderId)) {\n      addHistoryCandidate(senderId, key?.senderPn, "message-sender-pn");\n      addHistoryCandidate(senderId, record.senderPn, "message-sender-pn");\n      addHistoryCandidate(senderId, record.authorPn, "message-author-pn");\n    }\n\n    const to = record.to;\n    const toId = serializedId(to).toLowerCase();\n    if (targetIds.has(toId)) addHistoryCandidate(toId, record.toAlt ?? record.recipientPn, "message-recipient-alt");''',
    '''    if (targetIds.has(senderId)) {\n      addHistoryCandidate(senderId, key?.senderPn, "message-sender-pn");\n      addHistoryCandidate(senderId, record.senderPn, "message-sender-pn");\n      addHistoryCandidate(senderId, record.authorPn, "message-author-pn");\n      addHistoryCandidate(senderId, record.fromPn, "message-from-pn");\n      addHistoryCandidate(senderId, record.fromAlt, "message-from-alt");\n    }\n\n    const to = record.to;\n    const toId = serializedId(to).toLowerCase();\n    if (targetIds.has(toId)) {\n      addHistoryCandidate(toId, record.toAlt, "message-to-alt");\n      addHistoryCandidate(toId, record.toPn, "message-to-pn");\n      addHistoryCandidate(toId, record.recipientPn, "message-recipient-pn");\n    }''',
    'message from/to alternate PN metadata'
)
marker = '''  const globalMessages = listFrom(msgCollection);\n  const maxMessages = 100000;\n  const startAt = Math.max(0, globalMessages.length - maxMessages);\n  for (let index = startAt; index < globalMessages.length; index += 1) scanMessageMetadata(globalMessages[index]);\n\n  let historyResolved = 0;'''
replacement = '''  const globalMessages = listFrom(msgCollection);\n  const maxMessages = 100000;\n  const startAt = Math.max(0, globalMessages.length - maxMessages);\n  for (let index = startAt; index < globalMessages.length; index += 1) scanMessageMetadata(globalMessages[index]);\n\n  // 4) Historical messages persisted by WhatsApp Web in IndexedDB.\n  // WPPConnect/WA-JS currently reads the same model-storage/message store directly.\n  // We inspect only addressing/receipt metadata from cursor values; body/media/content\n  // fields are never accessed or persisted. The scan is bounded to protect the tab.\n  let historyIndexedDbSupported = false;\n  let historyIndexedDbMessagesScanned = 0;\n  let historyIndexedDbError = false;\n  if (targetIds.size > 0 && typeof globalThis.indexedDB !== "undefined") {\n    const idbFactory = globalThis.indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };\n    let databaseMayExist = true;\n    if (typeof idbFactory.databases === "function") {\n      try {\n        const databases = await idbFactory.databases();\n        databaseMayExist = databases.some((database) => database.name === "model-storage");\n      } catch {\n        // Continue with a guarded open; onupgradeneeded aborts instead of creating a new DB.\n      }\n    }\n\n    if (databaseMayExist) {\n      await new Promise<void>((resolve) => {\n        let request: IDBOpenDBRequest;\n        try {\n          request = idbFactory.open("model-storage");\n        } catch {\n          historyIndexedDbError = true;\n          resolve();\n          return;\n        }\n        request.onupgradeneeded = () => {\n          historyIndexedDbError = true;\n          try { request.transaction?.abort(); } catch { /* no-op */ }\n        };\n        request.onerror = () => {\n          historyIndexedDbError = true;\n          resolve();\n        };\n        request.onsuccess = () => {\n          const db = request.result;\n          if (!db.objectStoreNames.contains("message")) {\n            db.close();\n            resolve();\n            return;\n          }\n          historyIndexedDbSupported = true;\n          let transaction: IDBTransaction;\n          try {\n            transaction = db.transaction(["message"], "readonly");\n          } catch {\n            historyIndexedDbError = true;\n            db.close();\n            resolve();\n            return;\n          }\n          const store = transaction.objectStore("message");\n          const cursorRequest = store.openCursor();\n          const maxIndexedDbMessages = 250000;\n          let finished = false;\n          const finish = (errored = false): void => {\n            if (finished) return;\n            finished = true;\n            if (errored) historyIndexedDbError = true;\n            try { db.close(); } catch { /* no-op */ }\n            resolve();\n          };\n          cursorRequest.onerror = () => finish(true);\n          cursorRequest.onsuccess = () => {\n            const cursor = cursorRequest.result;\n            if (!cursor || historyIndexedDbMessagesScanned >= maxIndexedDbMessages) {\n              finish(false);\n              return;\n            }\n            historyIndexedDbMessagesScanned += 1;\n            scanMessageMetadata(cursor.value);\n            cursor.continue();\n          };\n          transaction.onabort = () => finish(true);\n          transaction.onerror = () => { historyIndexedDbError = true; };\n        };\n      });\n    }\n  }\n\n  let historyResolved = 0;'''
text = replace_once(text, marker, replacement, 'IndexedDB history scan insertion')
text = replace_once(
    text,
    '''    historyMessagesScanned,\n    historyChatsPresent,\n    historyConflicts\n  };''',
    '''    historyMessagesScanned,\n    historyChatsPresent,\n    historyConflicts,\n    historyIndexedDbSupported,\n    historyIndexedDbMessagesScanned,\n    historyIndexedDbError\n  };''',
    'resolver return IndexedDB stats'
)
write(path, text)

# Runtime diagnostics.
path = 'src/background/contact-export-runtime.ts'
text = read(path)
text = replace_once(
    text,
    '''  "phoneHistoryChatsPresent",\n  "phoneHistoryConflicts",\n  "visualHydrationUsed"''',
    '''  "phoneHistoryChatsPresent",\n  "phoneHistoryConflicts",\n  "phoneHistoryIndexedDbSupported",\n  "phoneHistoryIndexedDbMessagesScanned",\n  "phoneHistoryIndexedDbError",\n  "visualHydrationUsed"''',
    'runtime diagnostic allowlist IndexedDB'
)
text = replace_once(
    text,
    '''        remaining: 0, querySupported: false, historyResolved: 0,\n        historyMessagesScanned: 0, historyChatsPresent: 0, historyConflicts: 0\n      };''',
    '''        remaining: 0, querySupported: false, historyResolved: 0,\n        historyMessagesScanned: 0, historyChatsPresent: 0, historyConflicts: 0,\n        historyIndexedDbSupported: false, historyIndexedDbMessagesScanned: 0, historyIndexedDbError: false\n      };''',
    'runtime initial IndexedDB stats'
)
text = replace_once(
    text,
    '''            historyMessagesScanned: batch.historyMessagesScanned,\n            historyChatsPresent: batch.historyChatsPresent,\n            historyConflicts: batch.historyConflicts\n          };''',
    '''            historyMessagesScanned: batch.historyMessagesScanned,\n            historyChatsPresent: batch.historyChatsPresent,\n            historyConflicts: batch.historyConflicts,\n            historyIndexedDbSupported: batch.historyIndexedDbSupported,\n            historyIndexedDbMessagesScanned: batch.historyIndexedDbMessagesScanned,\n            historyIndexedDbError: batch.historyIndexedDbError\n          };''',
    'runtime batch IndexedDB stats'
)
text = replace_once(
    text,
    '''            phoneHistoryChatsPresent: resolutionStats.historyChatsPresent,\n            phoneHistoryConflicts: resolutionStats.historyConflicts,\n            visualHydrationUsed: false''',
    '''            phoneHistoryChatsPresent: resolutionStats.historyChatsPresent,\n            phoneHistoryConflicts: resolutionStats.historyConflicts,\n            phoneHistoryIndexedDbSupported: resolutionStats.historyIndexedDbSupported,\n            phoneHistoryIndexedDbMessagesScanned: resolutionStats.historyIndexedDbMessagesScanned,\n            phoneHistoryIndexedDbError: resolutionStats.historyIndexedDbError,\n            visualHydrationUsed: false''',
    'runtime IndexedDB technical details'
)
write(path, text)

# Add regression test for persisted history when Chat/Msg memory is empty.
path = 'tests/contact-export-hydration.test.ts'
text = read(path)
insert_before = '''  it("fails closed when historical metadata gives two different phone numbers for the same LID", async () => {'''
new_test = r'''  it("resolves a LID from persisted model-storage history when no chat or message is loaded in memory", async () => {
    const lid = "123456789012345@lid";
    const phone = "5491123456789@c.us";
    const originalIndexedDb = globalThis.indexedDB;
    try {
      const fakeIndexedDb = {
        databases: async () => [{ name: "model-storage" }],
        open: () => {
          const request: Record<string, unknown> = {};
          queueMicrotask(() => {
            const db = {
              objectStoreNames: { contains: (name: string) => name === "message" },
              close: () => undefined,
              transaction: () => ({
                objectStore: () => ({
                  openCursor: () => {
                    const cursorRequest: Record<string, unknown> = {};
                    queueMicrotask(() => {
                      const cursor = {
                        value: { from: lid, fromPn: phone, body: "THIS MUST NOT BE NEEDED" },
                        continue: () => queueMicrotask(() => {
                          cursorRequest.result = null;
                          const handler = cursorRequest.onsuccess as (() => void) | undefined;
                          handler?.();
                        })
                      };
                      cursorRequest.result = cursor;
                      const handler = cursorRequest.onsuccess as (() => void) | undefined;
                      handler?.();
                    });
                    return cursorRequest;
                  }
                }),
                onabort: null,
                onerror: null
              })
            };
            request.result = db;
            const handler = request.onsuccess as (() => void) | undefined;
            handler?.();
          });
          return request;
        }
      };
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDb });
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
            Chat: { get: () => undefined },
            Msg: { getModelsArray: () => [] },
            Label: { getModelsArray: () => [] }
          };
          return {};
        }
      });

      const result = await inspectWhatsAppLidsMainWorld([lid]);
      expect(result.resolved).toBe(1);
      expect(result.phones[lid]).toBe(phone);
      expect(result.historyResolved).toBe(1);
      expect(result.historyIndexedDbSupported).toBe(true);
      expect(result.historyIndexedDbMessagesScanned).toBe(1);
      expect(result.historyIndexedDbError).toBe(false);
      expect(result.strategies[lid]).toContain("message-from-pn");
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: originalIndexedDb });
    }
  });

'''
text = replace_once(text, insert_before, new_test + insert_before, 'insert IndexedDB regression test')
write(path, text)

# Build validator and docs.
path = 'scripts/validate-build.mjs'
text = read(path)
text = replace_once(
    text,
    'if (!backgroundWorker.includes("message-user-receipt") || !backgroundWorker.includes("history-metadata-lid-map") || !backgroundWorker.includes("phoneLookupServerSkipped")) {',
    'if (!backgroundWorker.includes("message-user-receipt") || !backgroundWorker.includes("history-metadata-lid-map") || !backgroundWorker.includes("phoneLookupServerSkipped") || !backgroundWorker.includes("model-storage") || !backgroundWorker.includes("phoneHistoryIndexedDbMessagesScanned")) {',
    'validate-build IndexedDB marker'
)
write(path, text)

path = 'docs/contact-export-release-notes-0.9.5.6.md'
text = read(path)
appendix = '''\n## Persistencia histórica IndexedDB\n\nAdemás de los modelos que WhatsApp mantiene cargados en memoria, 0.9.5.6 inspecciona de forma read-only el `model-storage` / object store `message`, el mismo origen que WA-JS expone mediante `WPP.indexdb.getMessagesFromRowId`. El cursor está limitado a 250.000 registros por análisis y sólo se acceden campos de addressing/receipt necesarios para correlacionar el LID exacto con un PN; no se accede ni se persiste `body`, media ni contenido conversacional.\n\nDiagnóstico adicional: `phoneHistoryIndexedDbSupported`, `phoneHistoryIndexedDbMessagesScanned` y `phoneHistoryIndexedDbError`.\n'''
if '## Persistencia histórica IndexedDB' not in text:
    text += appendix
write(path, text)

path = 'docs/whatsapp-contact-export.md'
text = read(path)
needle = 'La inspección se limita a addressing/receipt metadata; no lee ni persiste el cuerpo de mensajes. Conflictos de mapping quedan sin resolver.'
replacement = needle + ' También revisa en modo read-only el historial persistido por WhatsApp en IndexedDB `model-storage` / `message`, con un límite de 250.000 registros y sin acceder al cuerpo o media del mensaje.'
if needle in text and 'límite de 250.000 registros' not in text:
    text = text.replace(needle, replacement, 1)
write(path, text)

print('Applied IndexedDB history scan to Contact Export 0.9.5.6')
