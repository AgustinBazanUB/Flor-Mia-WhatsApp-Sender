import { ERROR_CODES, ExtensionError } from "../shared/errors";
import { CONTACT_EXPORT_ERROR_CODES, type ContactExportCollectionResult, type ContactKind, type RawContactCandidate, type WhatsAppLabelInfo } from "./types";

export interface MainWorldContactSnapshot {
  chatId: string;
  phoneJid: string | null;
  name: string;
  kind: ContactKind;
  phoneResolution: "direct-pn" | "contact-phone" | "lid-map" | "unresolved";
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
  const globalStore = asRecord(globalWindow.Store);
  const lidUtils = globalStore?.LidUtils;
  const resolveLidPhone = async (wid: unknown): Promise<string | null> => {
    const apiMapped = call(apiContact, "getPhoneNumber", wid);
    if (apiMapped !== undefined) {
      try {
        const resolved = await Promise.resolve(apiMapped);
        const phone = pnJid(resolved);
        if (phone) return phone;
      } catch {
        // Fallback local siguiente.
      }
    }
    const storeMapped = call(lidUtils, "getPhoneNumber", wid);
    if (storeMapped !== undefined) {
      try {
        const resolved = await Promise.resolve(storeMapped);
        const phone = pnJid(resolved);
        if (phone) return phone;
      } catch {
        // No hay mapeo local para este LID.
      }
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
        const mapped = await resolveLidPhone(wid);
        if (mapped) {
          phoneJid = mapped;
          phoneResolution = "lid-map";
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
