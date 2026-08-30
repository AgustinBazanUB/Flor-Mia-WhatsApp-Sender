// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  assignWhatsAppChatToLabelMainWorld,
  inspectWhatsAppGlobalMessageSearchMainWorld,
  inspectWhatsAppLabelMemberCountMainWorld
} from "../src/contact-export/whatsapp-message-search-main-world";
import type { MessageSearchOptions } from "../src/contact-export/add-contacts-by-message";

const options: MessageSearchOptions = {
  searchText: "Hola, quiero más información",
  mode: "contains",
  inboundOnly: true,
  excludeGroups: true,
  excludeCommunities: true,
  excludeChannels: true
};

afterEach(() => {
  delete (window as unknown as { require?: unknown }).require;
});

function installStructuredWhatsApp(messages: unknown[], initialMembers: string[] = []) {
  const labelItems: Array<Record<string, unknown>> = initialMembers.map((id) => ({ parentType: "Chat", parentId: id }));
  const contacts = new Map<string, Record<string, unknown>>();
  const chats = new Map<string, Record<string, unknown>>();
  for (const raw of messages) {
    const record = raw as Record<string, unknown>;
    const id = record.id as Record<string, unknown> | undefined;
    const chatId = String(id?.remote || record.from || "");
    if (!chatId || chats.has(chatId)) continue;
    const contact = { id: chatId, name: `Nombre ${contacts.size + 1}` };
    contacts.set(chatId, contact);
    chats.set(chatId, { id: chatId, contact, name: contact.name });
  }
  const label = {
    id: "label-1",
    name: "Interesados",
    labelItemCollection: { getModelsArray: () => labelItems }
  };
  const labelCollection = {
    getModelsArray: () => [label],
    addOrRemoveLabels: async (actions: Array<{ id: string; type: string }>, chatModels: Array<Record<string, unknown>>) => {
      expect(actions).toEqual([{ id: "label-1", type: "add" }]);
      for (const chat of chatModels) {
        const chatId = String(chat.id || "");
        if (chatId && !labelItems.some((item) => item.parentId === chatId)) labelItems.push({ parentType: "Chat", parentId: chatId });
      }
    }
  };
  const collections = {
    Msg: {
      search: async (_query: string, page: number) => ({ messages: page === 0 ? messages : [] })
    },
    Label: labelCollection,
    Chat: {
      get: (id: unknown) => chats.get(typeof id === "string" ? id : String((id as Record<string, unknown>)?._serialized || "")),
      find: async (id: string) => chats.get(id)
    },
    Contact: {
      get: (id: unknown) => contacts.get(typeof id === "string" ? id : String((id as Record<string, unknown>)?._serialized || "")),
      find: async (id: string) => contacts.get(id)
    }
  };
  Object.defineProperty(window, "require", {
    configurable: true,
    value: (name: string) => {
      if (name === "WAWebCollections") return collections;
      if (name === "WAWebWidFactory") return { createWid: (id: string) => ({ _serialized: id }) };
      return {};
    }
  });
  return { labelItems, chats };
}

describe("Add Contacts By Message MAIN-world", () => {
  it("usa WAWebCollections.Msg.search sin abrir chats y devuelve membresía actual", async () => {
    installStructuredWhatsApp([
      { id: { _serialized: "m1", remote: "5491111111111@c.us", fromMe: false }, body: "Hola, quiero más información" },
      { id: { $1: "m2", remote: "5491222222222@c.us", fromMe: false }, body: "Hola, quiero más información sobre aceite" }
    ], ["5491111111111@c.us"]);
    const result = await inspectWhatsAppGlobalMessageSearchMainWorld("Interesados", options);
    expect(result.supported).toBe(true);
    expect(result.targetLabelMemberCount).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ alreadyInList: true, fromMe: false, kind: "contact" });
    expect(result.results[1]).toMatchObject({ alreadyInList: false, fromMe: false, kind: "contact" });
    expect(result.metrics).toMatchObject({ chatsOpened: 0, visualOperations: 0, messagesMatched: 2 });
  });

  it("vuelve a comprobar exact localmente aunque la búsqueda global devuelva un mensaje más largo", async () => {
    installStructuredWhatsApp([
      { id: { _serialized: "m1", remote: "5491111111111@c.us", fromMe: false }, body: "Hola, quiero más información sobre el aceite" }
    ]);
    const result = await inspectWhatsAppGlobalMessageSearchMainWorld("Interesados", { ...options, mode: "exact" });
    expect(result.results).toHaveLength(0);
    expect(result.metrics.messagesMatched).toBe(0);
  });

  it("clasifica grupo/canal para que la capa de dominio los excluya", async () => {
    installStructuredWhatsApp([
      { id: { _serialized: "g", remote: "12345@g.us", fromMe: false }, body: options.searchText },
      { id: { _serialized: "n", remote: "12345@newsletter", fromMe: false }, body: options.searchText }
    ]);
    const result = await inspectWhatsAppGlobalMessageSearchMainWorld("Interesados", options);
    expect(result.results.map((entry) => entry.kind)).toEqual(["group", "channel"]);
    expect(result.metrics.excludedNonContacts).toBe(2);
  });

  it("queda no soportado y permite semáforo ROJO cuando cambia Msg.search", async () => {
    Object.defineProperty(window, "require", {
      configurable: true,
      value: (name: string) => name === "WAWebCollections"
        ? { Msg: {}, Label: { getModelsArray: () => [] } }
        : {}
    });
    const result = await inspectWhatsAppGlobalMessageSearchMainWorld("Interesados", options);
    expect(result).toMatchObject({ supported: false, reason: "WAWebCollections.Msg.search unavailable" });
  });

  it("agrega sólo la etiqueta destino y confirma membresía antes de devolver ADDED", async () => {
    installStructuredWhatsApp([
      { id: { _serialized: "m1", remote: "5491111111111@c.us", fromMe: false }, body: options.searchText }
    ]);
    const result = await assignWhatsAppChatToLabelMainWorld("Interesados", "5491111111111@c.us");
    expect(result).toMatchObject({ status: "ADDED", verified: true, memberCount: 1 });
    const refreshed = await inspectWhatsAppLabelMemberCountMainWorld("Interesados");
    expect(refreshed).toMatchObject({ supported: true, found: true, memberCount: 1 });
  });

  it("no repite la operación si el chat ya pertenece a la lista", async () => {
    installStructuredWhatsApp([
      { id: { _serialized: "m1", remote: "5491111111111@c.us", fromMe: false }, body: options.searchText }
    ], ["5491111111111@c.us"]);
    const result = await assignWhatsAppChatToLabelMainWorld("Interesados", "5491111111111@c.us");
    expect(result).toMatchObject({ status: "ALREADY_IN_LIST", verified: true, memberCount: 1 });
  });
});
