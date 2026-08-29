import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { CONTACT_EXPORT_ERROR_CODES, type ContactExportCollectionResult, type ContactKind, type RawContactCandidate, type WhatsAppLabelInfo } from "./types";
import { normalizeWhatsAppJidPhone } from "./phone-normalizer";

export interface MainWorldContactSnapshot {
  chatId: string;
  phoneJid: string | null;
  name: string;
  kind: ContactKind;
  phoneResolution: "direct-pn" | "contact-phone" | "lid-map" | "lid-cache" | "alternate-user" | "frontend-contact" | "contact-record" | "unresolved";
}

export interface MainWorldLabelSnapshot {
  requestedName: string;
  found: boolean;
  internalLabelId: string | null;
  chatCount: number;
  entries: MainWorldContactSnapshot[];
}

export interface MainWorldContactExportSnapshot {
  supported: boolean;
  reason: string | null;
  labels: MainWorldLabelSnapshot[];
}

/**
 * Se ejecuta con chrome.scripting en world=MAIN. Debe ser autocontenida porque
 * Chrome serializa la función y no conserva imports/cierres del bundle.
 * Sólo lee estado ya cargado por WhatsApp Web; no abre chats ni hace requests.
 */
export async function inspectWhatsAppLabelsMainWorld(selectedLabelNames: string[]): Promise<MainWorldContactExportSnapshot> {
  const asRecord = (value: unknown): Record<string, unknown> | null => {
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  };
  const get = (target: unknown, key: string): unknown => asRecord(target)?.[key];
  const call = (target: unknown, key: string, ...args: unknown[]): unknown => {
    const fn = get(target, key);
    if (typeof fn !== "function") return undefined;
    try {
      return Reflect.apply(fn, target, args);
    } catch {
      return undefined;
    }
  };
  const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
  const normalizedName = (value: unknown): string => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").toLocaleLowerCase("es");
  const serializedId = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number") return String(value);
    const record = asRecord(value);
    if (!record) return "";
    const direct = text(record._serialized) || text(record.serialized) || text(record.id);
    if (direct) return direct;
    const user = text(record.user);
    const server = text(record.server);
    return user && server ? `${user}@${server}` : "";
  };
  const modelName = (model: unknown): string => {
    const record = asRecord(model);
    if (!record) return "";
    const serialized = asRecord(call(model, "serialize"));
    return text(record.name)
      || text(record.formattedName)
      || text(record.shortName)
      || text(serialized?.name)
      || text(serialized?.formattedName)
      || text(record.pushname)
      || "";
  };
  const looksPhoneLike = (value: string): boolean => {
    const compact = value.replace(/[\s()\-.]/g, "");
    return /^\+?\d{8,15}$/.test(compact);
  };
  const cleanName = (contact: unknown, chat: unknown): string => {
    const contactName = modelName(contact);
    const chatRecord = asRecord(chat);
    const candidate = contactName
      || text(chatRecord?.formattedTitle)
      || text(chatRecord?.name)
      || text(chatRecord?.title)
      || "";
    if (!candidate || looksPhoneLike(candidate)) return "";
    return candidate.replace(/\s+/g, " ").slice(0, 160);
  };
  const kindFromId = (id: string): ContactKind => {
    if (/status@broadcast/i.test(id)) return "status";
    if (/@newsletter/i.test(id)) return "channel";
    if (/community/i.test(id)) return "community";
    if (/@g\.us/i.test(id)) return "group";
    if (/@broadcast/i.test(id)) return "system";
    if (/@(c\.us|s\.whatsapp\.net|lid)$/i.test(id)) return "contact";
    return "unknown";
  };
  const pnJid = (value: unknown): string | null => {
    const serialized = serializedId(value);
    const match = serialized.match(/^(\d{8,15})@(c\.us|s\.whatsapp\.net)$/i);
    if (match?.[1]) return `${match[1]}@c.us`;
    if (/^[1-9]\d{7,14}$/.test(serialized)) return `${serialized}@c.us`;
    return null;
  };
  const collectionGet = (collection: unknown, idValue: unknown, serialized: string): unknown => {
    const direct = call(collection, "get", idValue);
    if (direct) return direct;
    return serialized ? call(collection, "get", serialized) : undefined;
  };
  const globalWindow = window as unknown as { require?: (name: string) => unknown; Store?: unknown };
  const requireFn = globalWindow.require;
  if (typeof requireFn !== "function") return { supported: false, reason: "window.require unavailable", labels: [] };

  const safeRequire = (name: string): unknown => {
    try {
      return requireFn(name);
    } catch {
      return undefined;
    }
  };
  const collections = asRecord(safeRequire("WAWebCollections"));
  const labelCollection = collections?.Label;
  const chatCollection = collections?.Chat;
  const contactCollection = collections?.Contact;
  const labelModels = call(labelCollection, "getModelsArray");
  if (!Array.isArray(labelModels)) return { supported: false, reason: "WAWebCollections.Label unavailable", labels: [] };

  const widFactory = safeRequire("WAWebWidFactory");
  const apiContact = safeRequire("WAWebApiContact");
  const apiContactRecord = asRecord(apiContact);
  const lidPnCache = apiContactRecord?.lidPnCache;
  const frontendContactGetters = safeRequire("WAWebFrontendContactGetters");
  const globalStore = asRecord(globalWindow.Store);
  const lidUtils = globalStore?.LidUtils;
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
  const resolveAttempt = async (value: unknown): Promise<string | null> => {
    if (value === undefined || value === null) return null;
    try {
      return phoneFromUnknown(await Promise.resolve(value));
    } catch {
      return null;
    }
  };
  const resolveLidPhone = async (wid: unknown, contact: unknown): Promise<{ phone: string; resolution: MainWorldContactSnapshot["phoneResolution"] } | null> => {
    const attempts: Array<[MainWorldContactSnapshot["phoneResolution"], unknown]> = [
      ["lid-map", call(apiContact, "getPhoneNumber", wid)],
      ["lid-cache", call(lidPnCache, "getPhoneNumber", wid)],
      ["lid-cache", get(call(lidPnCache, "getLidEntry", wid), "phoneNumber")],
      ["alternate-user", call(apiContact, "getAlternateUserWid", wid)],
      ["alternate-user", call(apiContact, "getPnIfLidIsLatestMapping", wid)],
      ["frontend-contact", call(frontendContactGetters, "getPnForLid", contact)],
      ["contact-record", call(apiContact, "getContactRecord", wid)],
      ["lid-map", call(lidUtils, "getPhoneNumber", wid)]
    ];
    for (const [resolution, value] of attempts) {
      const phone = await resolveAttempt(value);
      if (phone) return { phone, resolution };
    }
    return null;
  };

  const output: MainWorldLabelSnapshot[] = [];
  for (const requestedName of selectedLabelNames) {
    const wanted = normalizedName(requestedName);
    const matching = labelModels.filter((model) => normalizedName(modelName(model)) === wanted);
    if (matching.length !== 1) {
      output.push({ requestedName, found: false, internalLabelId: null, chatCount: 0, entries: [] });
      continue;
    }
    const label = matching[0];
    const labelRecord = asRecord(label);
    const internalLabelId = serializedId(labelRecord?.id) || text(labelRecord?.id) || null;
    const itemCollection = labelRecord?.labelItemCollection;
    const items = call(itemCollection, "getModelsArray");
    if (!Array.isArray(items)) {
      return { supported: false, reason: "labelItemCollection unavailable", labels: [] };
    }
    const parentIds = new Map<string, unknown>();
    for (const item of items) {
      const record = asRecord(item);
      if (text(record?.parentType).toLocaleLowerCase() !== "chat") continue;
      const parentId = record?.parentId;
      const serialized = serializedId(parentId);
      if (serialized && !parentIds.has(serialized)) parentIds.set(serialized, parentId);
    }

    const entries: MainWorldContactSnapshot[] = [];
    for (const [chatId, rawId] of parentIds) {
      const kind = kindFromId(chatId);
      const wid = call(widFactory, "createWid", chatId) ?? rawId;
      const chat = collectionGet(chatCollection, rawId, chatId);
      const chatRecord = asRecord(chat);
      const contactFromChat = chatRecord?.contact;
      const contact = contactFromChat || collectionGet(contactCollection, wid, chatId) || collectionGet(contactCollection, rawId, chatId);
      const contactRecord = asRecord(contact);

      let phoneJid: string | null = pnJid(chatId);
      let phoneResolution: MainWorldContactSnapshot["phoneResolution"] = phoneJid ? "direct-pn" : "unresolved";
      if (!phoneJid) {
        const localPhone = pnJid(contactRecord?.phoneNumber) || pnJid(contactRecord?.id);
        if (localPhone) {
          phoneJid = localPhone;
          phoneResolution = "contact-phone";
        }
      }
      if (!phoneJid && /@lid$/i.test(chatId)) {
        const mapped = await resolveLidPhone(wid, contact);
        if (mapped) {
          phoneJid = mapped.phone;
          phoneResolution = mapped.resolution;
        }
      }

      entries.push({
        chatId,
        phoneJid,
        name: cleanName(contact, chat),
        kind,
        phoneResolution
      });
    }
    output.push({ requestedName, found: true, internalLabelId, chatCount: parentIds.size, entries });
  }
  return { supported: true, reason: null, labels: output };
}

export interface MainWorldLidResolutionBatch {
  phones: Record<string, string>;
  strategies: Record<string, string>;
  attempted: number;
  resolved: number;
  localResolved: number;
  serverQueried: number;
  serverResolved: number;
  querySupported: boolean;
  historyResolved: number;
  historyMessagesScanned: number;
  historyChatsPresent: number;
  historyConflicts: number;
  historyIndexedDbSupported: boolean;
  historyIndexedDbMessagesScanned: number;
  historyIndexedDbError: boolean;
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
    historyResolved: 0, historyMessagesScanned: 0, historyChatsPresent: 0, historyConflicts: 0,
    historyIndexedDbSupported: false, historyIndexedDbMessagesScanned: 0, historyIndexedDbError: false
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
      addHistoryCandidate(senderId, record.fromPn, "message-from-pn");
      addHistoryCandidate(senderId, record.fromAlt, "message-from-alt");
    }

    const to = record.to;
    const toId = serializedId(to).toLowerCase();
    if (targetIds.has(toId)) {
      addHistoryCandidate(toId, record.toAlt, "message-to-alt");
      addHistoryCandidate(toId, record.toPn, "message-to-pn");
      addHistoryCandidate(toId, record.recipientPn, "message-recipient-pn");
    }
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

  // 4) Historical messages persisted by WhatsApp Web in IndexedDB.
  // WPPConnect/WA-JS currently reads the same model-storage/message store directly.
  // We inspect only addressing/receipt metadata from cursor values; body/media/content
  // fields are never accessed or persisted. The scan is bounded to protect the tab.
  let historyIndexedDbSupported = false;
  let historyIndexedDbMessagesScanned = 0;
  let historyIndexedDbError = false;
  if (targetIds.size > 0 && typeof globalThis.indexedDB !== "undefined") {
    const idbFactory = globalThis.indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
    let databaseMayExist = true;
    if (typeof idbFactory.databases === "function") {
      try {
        const databases = await idbFactory.databases();
        databaseMayExist = databases.some((database) => database.name === "model-storage");
      } catch {
        // Continue with a guarded open; onupgradeneeded aborts instead of creating a new DB.
      }
    }

    if (databaseMayExist) {
      await new Promise<void>((resolve) => {
        let request: IDBOpenDBRequest;
        try {
          request = idbFactory.open("model-storage");
        } catch {
          historyIndexedDbError = true;
          resolve();
          return;
        }
        request.onupgradeneeded = () => {
          historyIndexedDbError = true;
          try { request.transaction?.abort(); } catch { /* no-op */ }
        };
        request.onerror = () => {
          historyIndexedDbError = true;
          resolve();
        };
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("message")) {
            db.close();
            resolve();
            return;
          }
          historyIndexedDbSupported = true;
          let transaction: IDBTransaction;
          try {
            transaction = db.transaction(["message"], "readonly");
          } catch {
            historyIndexedDbError = true;
            db.close();
            resolve();
            return;
          }
          const store = transaction.objectStore("message");
          const cursorRequest = store.openCursor();
          const maxIndexedDbMessages = 250000;
          let finished = false;
          const finish = (errored = false): void => {
            if (finished) return;
            finished = true;
            if (errored) historyIndexedDbError = true;
            try { db.close(); } catch { /* no-op */ }
            resolve();
          };
          cursorRequest.onerror = () => finish(true);
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor || historyIndexedDbMessagesScanned >= maxIndexedDbMessages) {
              finish(false);
              return;
            }
            historyIndexedDbMessagesScanned += 1;
            scanMessageMetadata(cursor.value);
            cursor.continue();
          };
          transaction.onabort = () => finish(true);
          transaction.onerror = () => { historyIndexedDbError = true; };
        };
      });
    }
  }

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
    const onlyEntry = [...byPhone.entries()][0];
    if (!onlyEntry) continue;
    const [phone, sources] = onlyEntry;
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
    historyConflicts,
    historyIndexedDbSupported,
    historyIndexedDbMessagesScanned,
    historyIndexedDbError
  };
}

export async function resolveWhatsAppLidsInMainWorld(tabId: number, contactIds: string[]): Promise<MainWorldLidResolutionBatch> {
  const unique = [...new Set(contactIds.map((id) => id.trim()).filter((id) => /^\d{8,20}@lid$/i.test(id)))].slice(0, 1000);
  const empty = (): MainWorldLidResolutionBatch => ({
    phones: {}, strategies: {}, attempted: unique.length, resolved: 0,
    localResolved: 0, serverQueried: 0, serverResolved: 0, querySupported: false,
    historyResolved: 0, historyMessagesScanned: 0, historyChatsPresent: 0, historyConflicts: 0,
    historyIndexedDbSupported: false, historyIndexedDbMessagesScanned: 0, historyIndexedDbError: false
  });
  if (!unique.length || !chrome.scripting?.executeScript) return empty();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: inspectWhatsAppLidsMainWorld,
      args: [unique]
    });
    return results[0]?.result as MainWorldLidResolutionBatch ?? empty();
  } catch {
    return empty();
  }
}

export interface ContactHydrationEvidence {
  candidates: RawContactCandidate[];
  hydratedPhones?: Record<string, string>;
  hydrationPasses?: number;
  strategy?: "virtualized-lid-hydration" | "server-assisted-lid-map" | "history-metadata-lid-map";
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
  const hydrationStrategy = evidence.strategy ?? "virtualized-lid-hydration";
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
      strategy: `${candidate.strategy}+${hydrationStrategy}`
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
      scopeStrategy: `main-world-label-store+${hydrationStrategy}`
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
      strategy: `main-world-label-store+${hydrationStrategy}`,
      labelResults,
      metrics
    },
    attempted: unresolvedBefore,
    resolved,
    remaining,
    passes: evidence.hydrationPasses ?? 0
  };
}

function opaqueSourceId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `wa_store_${hash.toString(36)}`;
}

export function mainWorldSnapshotToCollection(
  snapshot: MainWorldContactExportSnapshot,
  labels: WhatsAppLabelInfo[],
  startedAt = new Date()
): ContactExportCollectionResult | null {
  if (!snapshot.supported) return null;
  const byName = new Map(snapshot.labels.map((label) => [label.requestedName.trim().toLocaleLowerCase("es"), label]));
  const candidates: RawContactCandidate[] = [];
  const labelResults: ContactExportCollectionResult["labelResults"] = [];

  for (const label of labels) {
    const internal = byName.get(label.name.trim().toLocaleLowerCase("es"));
    if (!internal?.found) return null;
    if (label.countHint != null && internal.chatCount !== label.countHint) {
      throw new ExtensionError(ERROR_CODES.elementNotFound, "La cantidad estructurada de chats de la etiqueta no coincide con la cantidad informada por WhatsApp.", {
        recoverable: true,
        details: {
          contactExportCode: CONTACT_EXPORT_ERROR_CODES.labelContactCountMismatch,
          stage: "main_world_label_count_validation",
          strategy: "main-world-label-store+local-lid-map",
          expectedCount: label.countHint,
          collectedCount: internal.chatCount,
          internalChatCount: internal.chatCount,
          internalLabelIdPresent: Boolean(internal.internalLabelId)
        }
      });
    }

    let resolvedPhones = 0;
    let unresolvedPhones = 0;
    for (const entry of internal.entries) {
      const resolved = Boolean(entry.phoneJid);
      if (entry.kind === "contact" || entry.kind === "unknown") {
        if (resolved) resolvedPhones += 1;
        else unresolvedPhones += 1;
      }
      candidates.push({
        sourceId: opaqueSourceId(`${label.id}:${entry.chatId}`),
        contactId: entry.chatId,
        labelId: label.id,
        labelName: label.name,
        name: entry.name,
        phoneCandidate: entry.phoneJid,
        phoneSource: resolved ? "jid" : "none",
        phoneStatus: resolved ? "resolved" : "unresolved",
        kind: entry.kind,
        strategy: `main-world-${entry.phoneResolution}`
      });
    }
    labelResults.push({
      labelId: label.id,
      labelName: label.name,
      reportedCount: label.countHint ?? internal.chatCount,
      collectedUniqueContacts: internal.chatCount,
      resolvedPhones,
      unresolvedPhones,
      rowScans: internal.chatCount,
      scrollOperations: 0,
      scopeStrategy: "main-world-label-store+local-lid-map"
    });
  }

  const completedAt = new Date();
  const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
  const processed = labelResults.reduce((sum, item) => sum + item.collectedUniqueContacts, 0);
  return {
    candidates,
    strategy: "main-world-label-store+local-lid-map",
    labelResults,
    metrics: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      contactsPerSecond: durationMs > 0 ? Number((processed / (durationMs / 1000)).toFixed(2)) : null,
      labelsProcessed: labels.length,
      rowScans: processed,
      scrollOperations: 0,
      visualOperations: 0,
      chatsOpened: 0
    }
  };
}

export async function collectContactsFromWhatsAppMainWorld(
  tabId: number,
  labels: WhatsAppLabelInfo[]
): Promise<ContactExportCollectionResult | null> {
  if (!chrome.scripting?.executeScript) return null;
  let snapshot: MainWorldContactExportSnapshot | null = null;
  const startedAt = new Date();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: inspectWhatsAppLabelsMainWorld,
      args: [labels.map((label) => label.name)]
    });
    const result = results[0]?.result as MainWorldContactExportSnapshot | undefined;
    snapshot = result ?? null;
  } catch {
    return null;
  }
  return snapshot ? mainWorldSnapshotToCollection(snapshot, labels, startedAt) : null;
}
