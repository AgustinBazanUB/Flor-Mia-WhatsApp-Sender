import type {
  MessageSearchMainWorldSnapshot,
  MessageSearchOptions,
  RawMessageSearchResult
} from "./add-contacts-by-message";
import type { WhatsAppLabelInfo } from "./types";

export interface MessageListAssignmentResult {
  status: "ADDED" | "ALREADY_IN_LIST" | "FAILED";
  verified: boolean;
  memberCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  strategy: string;
}

export interface MessageListRefreshResult {
  supported: boolean;
  found: boolean;
  memberCount: number | null;
  strategy: string;
}

/**
 * MAIN-world structured global search. It deliberately does not navigate to any
 * conversation. Chrome serializes this function, so it must be self-contained.
 */
export async function inspectWhatsAppGlobalMessageSearchMainWorld(
  targetLabelName: string,
  options: MessageSearchOptions
): Promise<MessageSearchMainWorldSnapshot> {
  const startedAt = new Date();
  const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" ? value as Record<string, unknown> : null;
  const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
  const normalizedName = (value: unknown): string => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").toLocaleLowerCase("es");
  const normalizedMatch = (value: unknown): string => typeof value === "string" ? value.normalize("NFC").trim() : "";
  const matches = (value: unknown): boolean => {
    const message = normalizedMatch(value);
    const search = normalizedMatch(options.searchText);
    return Boolean(search) && (options.mode === "exact" ? message === search : message.includes(search));
  };
  const serializedId = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number") return String(value);
    const record = asRecord(value);
    if (!record) return "";
    const direct = text(record._serialized) || text(record.$1) || text(record.serialized);
    if (direct) return direct;
    if (typeof record.id === "string") return text(record.id);
    if (record.id && record.id !== value) {
      const nested = serializedId(record.id);
      if (nested) return nested;
    }
    const user = text(record.user);
    const server = text(record.server);
    return user && server ? `${user}@${server}` : "";
  };
  const call = (target: unknown, key: string, ...args: unknown[]): unknown => {
    const fn = asRecord(target)?.[key];
    if (typeof fn !== "function") return undefined;
    try { return Reflect.apply(fn, target, args); } catch { return undefined; }
  };
  const listModels = (collection: unknown): unknown[] => {
    const result = call(collection, "getModelsArray");
    if (Array.isArray(result)) return result;
    const models = asRecord(collection)?.models;
    return Array.isArray(models) ? models : [];
  };
  const kindFrom = (chatId: string, chat: unknown): RawMessageSearchResult["kind"] => {
    const chatRecord = asRecord(chat);
    if (/status@broadcast/i.test(chatId)) return "status";
    if (/@newsletter/i.test(chatId)) return "channel";
    if (chatRecord?.isCommunity === true || chatRecord?.isParentGroup === true || chatRecord?.isCommunityAnnouncement === true) return "community";
    if (/@g\.us$/i.test(chatId)) return "group";
    if (/@broadcast$/i.test(chatId)) return "system";
    if (/@(c\.us|s\.whatsapp\.net|lid)$/i.test(chatId)) return "contact";
    return "unknown";
  };
  const pnJid = (value: unknown): string | null => {
    const serialized = serializedId(value);
    const match = serialized.match(/^(\d{8,15})@(c\.us|s\.whatsapp\.net)$/i);
    if (match?.[1]) return `${match[1]}@c.us`;
    if (/^[1-9]\d{7,14}$/.test(serialized)) return `${serialized}@c.us`;
    return null;
  };
  const collectionGet = (collection: unknown, rawId: unknown, id: string): unknown => {
    const direct = call(collection, "get", rawId);
    return direct || (id ? call(collection, "get", id) : undefined);
  };
  const modelName = (model: unknown): string => {
    const record = asRecord(model);
    const serialized = asRecord(call(model, "serialize"));
    return text(record?.name) || text(record?.formattedName) || text(record?.shortName)
      || text(serialized?.name) || text(serialized?.formattedName) || text(record?.pushname) || "";
  };
  const cleanName = (contact: unknown, chat: unknown): string => {
    const chatRecord = asRecord(chat);
    const candidate = modelName(contact) || text(chatRecord?.formattedTitle) || text(chatRecord?.name) || text(chatRecord?.title);
    return /^\+?[\d\s().-]{8,}$/.test(candidate) ? "" : candidate.replace(/\s+/g, " ").slice(0, 160);
  };
  const messageText = (message: unknown): string => {
    const record = asRecord(message);
    const serialized = asRecord(call(message, "serialize"));
    for (const value of [record?.body, serialized?.body, record?.caption, serialized?.caption, record?.text, serialized?.text]) {
      if (typeof value === "string" && value) return value.slice(0, 4096);
    }
    return "";
  };
  const messageDirection = (message: unknown): boolean | null => {
    const record = asRecord(message);
    const id = asRecord(record?.id);
    const serialized = asRecord(call(message, "serialize"));
    const serializedIdRecord = asRecord(serialized?.id);
    for (const value of [id?.fromMe, record?.fromMe, serializedIdRecord?.fromMe, serialized?.fromMe]) {
      if (typeof value === "boolean") return value;
    }
    return null;
  };
  const messageRemoteId = (message: unknown, fromMe: boolean | null): string => {
    const record = asRecord(message);
    const serialized = asRecord(call(message, "serialize"));
    const id = asRecord(record?.id);
    const serializedMessageId = asRecord(serialized?.id);
    for (const value of [id?.remote, serializedMessageId?.remote, record?.remote, serialized?.remote]) {
      const candidate = serializedId(value);
      if (candidate) return candidate;
    }
    const preferred = fromMe === true ? [record?.to, serialized?.to] : [record?.from, serialized?.from];
    for (const value of preferred) {
      const candidate = serializedId(value);
      if (candidate) return candidate;
    }
    return "";
  };
  const messageStableId = (message: unknown, fallback: string): string => {
    const record = asRecord(message);
    const id = serializedId(record?.id) || serializedId(asRecord(call(message, "serialize"))?.id);
    return id || fallback;
  };

  const globalWindow = window as unknown as { require?: (name: string) => unknown };
  if (typeof globalWindow.require !== "function") {
    const completedAt = new Date();
    return {
      supported: false,
      reason: "window.require unavailable",
      targetLabelInternalId: null,
      targetLabelMemberCount: null,
      results: [],
      metrics: { startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), durationMs: completedAt.getTime() - startedAt.getTime(), searchPages: 0, messagesScanned: 0, messagesMatched: 0, directionUnknown: 0, excludedNonContacts: 0, chatsOpened: 0, visualOperations: 0 }
    };
  }
  const safeRequire = (name: string): unknown => {
    try { return globalWindow.require?.(name); } catch { return undefined; }
  };
  const collections = asRecord(safeRequire("WAWebCollections"));
  const msgCollection = collections?.Msg;
  const labelCollection = collections?.Label;
  const chatCollection = collections?.Chat;
  const contactCollection = collections?.Contact;
  const searchFn = asRecord(msgCollection)?.search;
  if (typeof searchFn !== "function") {
    const completedAt = new Date();
    return {
      supported: false,
      reason: "WAWebCollections.Msg.search unavailable",
      targetLabelInternalId: null,
      targetLabelMemberCount: null,
      results: [],
      metrics: { startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), durationMs: completedAt.getTime() - startedAt.getTime(), searchPages: 0, messagesScanned: 0, messagesMatched: 0, directionUnknown: 0, excludedNonContacts: 0, chatsOpened: 0, visualOperations: 0 }
    };
  }

  const labels = listModels(labelCollection);
  const wanted = normalizedName(targetLabelName);
  const matchingLabels = labels.filter((label) => normalizedName(modelName(label)) === wanted);
  if (matchingLabels.length !== 1) {
    const completedAt = new Date();
    return {
      supported: false,
      reason: matchingLabels.length ? "target label is ambiguous" : "target label not found",
      targetLabelInternalId: null,
      targetLabelMemberCount: null,
      results: [],
      metrics: { startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), durationMs: completedAt.getTime() - startedAt.getTime(), searchPages: 0, messagesScanned: 0, messagesMatched: 0, directionUnknown: 0, excludedNonContacts: 0, chatsOpened: 0, visualOperations: 0 }
    };
  }
  const targetLabel = matchingLabels[0];
  const labelRecord = asRecord(targetLabel);
  const targetLabelInternalId = serializedId(labelRecord?.id) || text(labelRecord?.id) || null;
  const membership = new Set<string>();
  for (const item of listModels(labelRecord?.labelItemCollection)) {
    const itemRecord = asRecord(item);
    if (text(itemRecord?.parentType).toLocaleLowerCase("en-US") !== "chat") continue;
    const id = serializedId(itemRecord?.parentId);
    if (id) membership.add(id.toLocaleLowerCase("en-US"));
  }

  const results: RawMessageSearchResult[] = [];
  const seenMessages = new Set<string>();
  let searchPages = 0;
  let messagesScanned = 0;
  let messagesMatched = 0;
  let directionUnknown = 0;
  let excludedNonContacts = 0;
  const pageSize = 100;
  const maxPages = 100;
  for (let page = 0; page < maxPages; page += 1) {
    let response: unknown;
    try {
      response = await Promise.resolve(Reflect.apply(searchFn, msgCollection, [options.searchText, page, pageSize, undefined]));
    } catch {
      break;
    }
    const pageMessages = Array.isArray(asRecord(response)?.messages)
      ? asRecord(response)?.messages as unknown[]
      : Array.isArray(response)
        ? response
        : [];
    searchPages += 1;
    if (!pageMessages.length) {
      if (page === 0) continue;
      break;
    }
    let newOnPage = 0;
    for (let index = 0; index < pageMessages.length; index += 1) {
      const message = pageMessages[index];
      const stableMessageId = messageStableId(message, `page-${page}-row-${index}`);
      if (seenMessages.has(stableMessageId)) continue;
      seenMessages.add(stableMessageId);
      newOnPage += 1;
      messagesScanned += 1;
      const body = messageText(message);
      if (!matches(body)) continue;
      messagesMatched += 1;
      const fromMe = messageDirection(message);
      if (options.inboundOnly && fromMe === null) directionUnknown += 1;
      const chatId = messageRemoteId(message, fromMe);
      const chat = collectionGet(chatCollection, chatId, chatId);
      const kind = kindFrom(chatId, chat);
      const excluded = kind === "status" || kind === "system"
        || (kind === "group" && options.excludeGroups)
        || (kind === "community" && options.excludeCommunities)
        || (kind === "channel" && options.excludeChannels);
      if (excluded) excludedNonContacts += 1;
      const chatRecord = asRecord(chat);
      let contact = chatRecord?.contact || collectionGet(contactCollection, chatId, chatId);
      if (!contact && chatId) {
        const finder = asRecord(contactCollection)?.find;
        if (typeof finder === "function") {
          try { contact = await Promise.resolve(Reflect.apply(finder, contactCollection, [chatId])); } catch { contact = undefined; }
        }
      }
      const contactRecord = asRecord(contact);
      const phoneCandidate = pnJid(chatId) || pnJid(contactRecord?.phoneNumber) || pnJid(contactRecord?.id);
      results.push({
        messageId: stableMessageId,
        chatId: chatId || null,
        contactId: chatId || null,
        phoneCandidate,
        name: cleanName(contact, chat),
        messageText: body.slice(0, 500),
        fromMe,
        kind,
        alreadyInList: Boolean(chatId) && membership.has(chatId.toLocaleLowerCase("en-US")),
        strategy: "main-world-global-msg-search"
      });
    }
    if (pageMessages.length < pageSize || newOnPage === 0) break;
  }

  const completedAt = new Date();
  return {
    supported: true,
    reason: null,
    targetLabelInternalId,
    targetLabelMemberCount: membership.size,
    results,
    metrics: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      searchPages,
      messagesScanned,
      messagesMatched,
      directionUnknown,
      excludedNonContacts,
      chatsOpened: 0,
      visualOperations: 0
    }
  };
}

/** MAIN-world single-contact label assignment with post-write verification. */
export async function assignWhatsAppChatToLabelMainWorld(
  targetLabelName: string,
  chatId: string
): Promise<MessageListAssignmentResult> {
  const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" ? value as Record<string, unknown> : null;
  const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
  const normalizedName = (value: unknown): string => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").toLocaleLowerCase("es");
  const serializedId = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    const record = asRecord(value);
    if (!record) return "";
    const direct = text(record._serialized) || text(record.$1) || text(record.serialized);
    if (direct) return direct;
    const user = text(record.user);
    const server = text(record.server);
    return user && server ? `${user}@${server}` : "";
  };
  const call = (target: unknown, key: string, ...args: unknown[]): unknown => {
    const fn = asRecord(target)?.[key];
    if (typeof fn !== "function") return undefined;
    try { return Reflect.apply(fn, target, args); } catch { return undefined; }
  };
  const listModels = (collection: unknown): unknown[] => {
    const models = call(collection, "getModelsArray");
    return Array.isArray(models) ? models : Array.isArray(asRecord(collection)?.models) ? asRecord(collection)?.models as unknown[] : [];
  };
  const modelName = (model: unknown): string => {
    const record = asRecord(model);
    const serialized = asRecord(call(model, "serialize"));
    return text(record?.name) || text(record?.formattedName) || text(serialized?.name) || text(serialized?.formattedName);
  };
  const globalWindow = window as unknown as { require?: (name: string) => unknown };
  if (typeof globalWindow.require !== "function") return { status: "FAILED", verified: false, memberCount: null, errorCode: "WHATSAPP_STRUCTURE_CHANGED", errorMessage: "window.require no está disponible.", strategy: "main-world-label-add" };
  const safeRequire = (name: string): unknown => { try { return globalWindow.require?.(name); } catch { return undefined; } };
  const collections = asRecord(safeRequire("WAWebCollections"));
  const labelCollection = collections?.Label;
  const chatCollection = collections?.Chat;
  const labels = listModels(labelCollection).filter((label) => normalizedName(modelName(label)) === normalizedName(targetLabelName));
  if (labels.length !== 1) return { status: "FAILED", verified: false, memberCount: null, errorCode: "LIST_MEMBERSHIP_CHECK_FAILED", errorMessage: "No se pudo identificar una única lista destino.", strategy: "main-world-label-add" };
  const label = labels[0];
  const labelRecord = asRecord(label);
  const labelId = serializedId(labelRecord?.id) || text(labelRecord?.id);
  const memberIds = (): Set<string> => {
    const output = new Set<string>();
    for (const item of listModels(labelRecord?.labelItemCollection)) {
      const itemRecord = asRecord(item);
      if (text(itemRecord?.parentType).toLocaleLowerCase("en-US") !== "chat") continue;
      const id = serializedId(itemRecord?.parentId);
      if (id) output.add(id.toLocaleLowerCase("en-US"));
    }
    return output;
  };
  if (memberIds().has(chatId.toLocaleLowerCase("en-US"))) {
    return { status: "ALREADY_IN_LIST", verified: true, memberCount: memberIds().size, errorCode: null, errorMessage: null, strategy: "main-world-label-membership" };
  }
  let chat = call(chatCollection, "get", chatId);
  if (!chat) {
    const widFactory = safeRequire("WAWebWidFactory");
    const wid = call(widFactory, "createWid", chatId);
    if (wid) chat = call(chatCollection, "get", wid);
  }
  if (!chat) {
    const finder = asRecord(chatCollection)?.find;
    if (typeof finder === "function") {
      try { chat = await Promise.resolve(Reflect.apply(finder, chatCollection, [chatId])); } catch { chat = undefined; }
    }
  }
  if (!chat || !labelId) return { status: "FAILED", verified: false, memberCount: memberIds().size, errorCode: "LIST_ASSIGNMENT_FAILED", errorMessage: "No se pudo resolver el chat o el identificador de la lista.", strategy: "main-world-label-add" };

  const addOrRemove = asRecord(labelCollection)?.addOrRemoveLabels;
  const addOrRemoveMd = asRecord(labelCollection)?.addOrRemoveLabelsMD;
  try {
    if (typeof addOrRemove === "function") {
      await Promise.resolve(Reflect.apply(addOrRemove, labelCollection, [[{ id: labelId, type: "add" }], [chat]]));
    } else if (typeof addOrRemoveMd === "function") {
      await Promise.resolve(Reflect.apply(addOrRemoveMd, labelCollection, [[{ id: labelId, type: "add" }], [chat]]));
    } else {
      return { status: "FAILED", verified: false, memberCount: memberIds().size, errorCode: "WHATSAPP_STRUCTURE_CHANGED", errorMessage: "WhatsApp no expone la operación de etiquetas esperada.", strategy: "main-world-label-add" };
    }
  } catch (error) {
    return { status: "FAILED", verified: false, memberCount: memberIds().size, errorCode: "LIST_ASSIGNMENT_FAILED", errorMessage: error instanceof Error ? error.message.slice(0, 300) : "Falló la operación de asignación.", strategy: "main-world-label-add" };
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (memberIds().has(chatId.toLocaleLowerCase("en-US"))) {
      return { status: "ADDED", verified: true, memberCount: memberIds().size, errorCode: null, errorMessage: null, strategy: "main-world-label-add+membership-verified" };
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  return { status: "FAILED", verified: false, memberCount: memberIds().size, errorCode: "LIST_ASSIGNMENT_NOT_CONFIRMED", errorMessage: "La operación se ejecutó pero la lista no confirmó la membresía.", strategy: "main-world-label-add+membership-verify" };
}

export async function inspectWhatsAppLabelMemberCountMainWorld(targetLabelName: string): Promise<MessageListRefreshResult> {
  const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" ? value as Record<string, unknown> : null;
  const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
  const normalizedName = (value: unknown): string => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").toLocaleLowerCase("es");
  const call = (target: unknown, key: string): unknown => {
    const fn = asRecord(target)?.[key];
    if (typeof fn !== "function") return undefined;
    try { return Reflect.apply(fn, target, []); } catch { return undefined; }
  };
  const modelName = (model: unknown): string => {
    const record = asRecord(model);
    return text(record?.name) || text(record?.formattedName) || text(asRecord(call(model, "serialize"))?.name);
  };
  const globalWindow = window as unknown as { require?: (name: string) => unknown };
  if (typeof globalWindow.require !== "function") return { supported: false, found: false, memberCount: null, strategy: "main-world-label-refresh" };
  let collections: Record<string, unknown> | null = null;
  try { collections = asRecord(globalWindow.require("WAWebCollections")); } catch { collections = null; }
  const labelCollection = collections?.Label;
  const models = call(labelCollection, "getModelsArray");
  if (!Array.isArray(models)) return { supported: false, found: false, memberCount: null, strategy: "main-world-label-refresh" };
  const matches = models.filter((model) => normalizedName(modelName(model)) === normalizedName(targetLabelName));
  if (matches.length !== 1) return { supported: true, found: false, memberCount: null, strategy: "main-world-label-refresh" };
  const labelItems = call(asRecord(matches[0])?.labelItemCollection, "getModelsArray");
  if (!Array.isArray(labelItems)) return { supported: false, found: true, memberCount: null, strategy: "main-world-label-refresh" };
  const count = labelItems.filter((item) => text(asRecord(item)?.parentType).toLocaleLowerCase("en-US") === "chat").length;
  return { supported: true, found: true, memberCount: count, strategy: "main-world-label-refresh" };
}

export async function searchWhatsAppMessagesMainWorld(
  tabId: number,
  targetLabel: WhatsAppLabelInfo,
  options: MessageSearchOptions
): Promise<MessageSearchMainWorldSnapshot | null> {
  if (!chrome.scripting?.executeScript) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: inspectWhatsAppGlobalMessageSearchMainWorld,
      args: [targetLabel.name, options]
    });
    return results[0]?.result as MessageSearchMainWorldSnapshot | null ?? null;
  } catch {
    return null;
  }
}

export async function assignWhatsAppChatToLabel(
  tabId: number,
  targetLabel: WhatsAppLabelInfo,
  chatId: string
): Promise<MessageListAssignmentResult> {
  if (!chrome.scripting?.executeScript) return { status: "FAILED", verified: false, memberCount: null, errorCode: "WHATSAPP_STRUCTURE_CHANGED", errorMessage: "chrome.scripting no está disponible.", strategy: "main-world-label-add" };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: assignWhatsAppChatToLabelMainWorld,
      args: [targetLabel.name, chatId]
    });
    return results[0]?.result as MessageListAssignmentResult;
  } catch (error) {
    return { status: "FAILED", verified: false, memberCount: null, errorCode: "LIST_ASSIGNMENT_FAILED", errorMessage: error instanceof Error ? error.message.slice(0, 300) : "No se pudo ejecutar la asignación.", strategy: "main-world-label-add" };
  }
}

export async function refreshWhatsAppLabelMemberCount(
  tabId: number,
  targetLabel: WhatsAppLabelInfo
): Promise<MessageListRefreshResult> {
  if (!chrome.scripting?.executeScript) return { supported: false, found: false, memberCount: null, strategy: "main-world-label-refresh" };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: inspectWhatsAppLabelMemberCountMainWorld,
      args: [targetLabel.name]
    });
    return results[0]?.result as MessageListRefreshResult;
  } catch {
    return { supported: false, found: false, memberCount: null, strategy: "main-world-label-refresh" };
  }
}
