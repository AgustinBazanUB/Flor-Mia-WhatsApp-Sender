import { describe, expect, it } from "vitest";
import {
  buildMessageContactPreview,
  calculateMessageContactProgress,
  matchesSearchRule,
  pendingMessageContactItems,
  recomputeMessageContactSummary,
  type MessageContactPreviewItem,
  type MessageSearchOptions,
  type RawMessageSearchResult
} from "../src/contact-export/add-contacts-by-message";

const options: MessageSearchOptions = {
  searchText: "Hola, quiero más información",
  mode: "contains",
  inboundOnly: true,
  excludeGroups: true,
  excludeCommunities: true,
  excludeChannels: true
};

function message(overrides: Partial<RawMessageSearchResult> = {}): RawMessageSearchResult {
  return {
    messageId: "m1",
    chatId: "5491111111111@c.us",
    contactId: "5491111111111@c.us",
    phoneCandidate: "5491111111111@c.us",
    name: "Cliente",
    messageText: "Hola, quiero más información",
    fromMe: false,
    kind: "contact",
    alreadyInList: false,
    strategy: "test-global-search",
    ...overrides
  };
}

describe("Agregar contactos por frase — reglas determinísticas", () => {
  it("CASO 1: una coincidencia recibida produce un contacto", () => {
    const result = buildMessageContactPreview([message()], options);
    expect(result.summary).toMatchObject({ messagesFound: 1, uniqueContacts: 1, newContacts: 1 });
    expect(result.items[0]?.status).toBe("NEW");
  });

  it("CASO 2 y 9: tres o veinte mensajes del mismo contacto producen una sola persona", () => {
    const three = Array.from({ length: 3 }, (_, index) => message({ messageId: `m${index}` }));
    const twenty = Array.from({ length: 20 }, (_, index) => message({ messageId: `x${index}` }));
    expect(buildMessageContactPreview(three, options).items).toHaveLength(1);
    const many = buildMessageContactPreview(twenty, options);
    expect(many.items).toHaveLength(1);
    expect(many.items[0]?.sourceMessageCount).toBe(20);
  });

  it("CASO 3: un mensaje enviado por mí no se incluye con received-only", () => {
    const result = buildMessageContactPreview([message({ fromMe: true })], options);
    expect(result.items).toHaveLength(0);
  });

  it("received-only falla cerrado si la dirección es desconocida", () => {
    const result = buildMessageContactPreview([message({ fromMe: null })], options);
    expect(result.items).toHaveLength(0);
    expect(result.directionUnknown).toBe(1);
  });

  it("CASO 4: contains acepta un mensaje que continúa después de la frase", () => {
    expect(matchesSearchRule("Hola, quiero más información sobre el aceite", options.searchText, "contains")).toBe(true);
  });

  it("CASO 5: exact rechaza el mismo mensaje si contiene texto adicional", () => {
    expect(matchesSearchRule("Hola, quiero más información sobre el aceite", options.searchText, "exact")).toBe(false);
    expect(matchesSearchRule("  Hola, quiero más información  ", options.searchText, "exact")).toBe(true);
  });

  it("CASO 6: un contacto que ya pertenece a la lista queda ALREADY_IN_LIST", () => {
    const result = buildMessageContactPreview([message({ alreadyInList: true })], options);
    expect(result.items[0]).toMatchObject({ status: "ALREADY_IN_LIST", assignmentStatus: "ALREADY_IN_LIST" });
    expect(result.summary.alreadyInList).toBe(1);
  });

  it("CASO 7: un contacto nuevo queda NEW y PENDING", () => {
    const result = buildMessageContactPreview([message()], options);
    expect(result.items[0]).toMatchObject({ status: "NEW", assignmentStatus: "PENDING" });
  });

  it("CASO 8: grupos, comunidades y canales se excluyen", () => {
    const result = buildMessageContactPreview([
      message({ messageId: "g", chatId: "123@g.us", contactId: "123@g.us", phoneCandidate: null, kind: "group" }),
      message({ messageId: "c", chatId: "456@g.us", contactId: "456@g.us", phoneCandidate: null, kind: "community" }),
      message({ messageId: "n", chatId: "789@newsletter", contactId: "789@newsletter", phoneCandidate: null, kind: "channel" })
    ], options);
    expect(result.items).toHaveLength(0);
    expect(result.excludedNonContacts).toBe(3);
  });

  it("deduplica por teléfono aunque contactId/chatId cambien", () => {
    const result = buildMessageContactPreview([
      message({ messageId: "one", chatId: "lid-one@lid", contactId: "lid-one@lid", phoneCandidate: "5491111111111@c.us" }),
      message({ messageId: "two", chatId: "5491111111111@c.us", contactId: "5491111111111@c.us", phoneCandidate: "5491111111111@s.whatsapp.net" })
    ], options);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.phone).toBe("+5491111111111");
  });

  it("usa contactId/chatId estable como fallback y nunca el nombre para deduplicar", () => {
    const result = buildMessageContactPreview([
      message({ messageId: "a", chatId: "111111111111111@lid", contactId: "111111111111111@lid", phoneCandidate: null, name: "Mismo Nombre" }),
      message({ messageId: "b", chatId: "222222222222222@lid", contactId: "222222222222222@lid", phoneCandidate: null, name: "Mismo Nombre" })
    ], options);
    expect(result.items).toHaveLength(2);
  });
});

describe("Agregar contactos por frase — checkpoint y progreso", () => {
  function item(index: number, assignmentStatus: MessageContactPreviewItem["assignmentStatus"] = "PENDING"): MessageContactPreviewItem {
    return {
      id: `item-${index}`,
      identityKey: `phone:549110000${String(index).padStart(4, "0")}`,
      chatId: `549110000${String(index).padStart(4, "0")}@c.us`,
      contactId: `549110000${String(index).padStart(4, "0")}@c.us`,
      phone: `+549110000${String(index).padStart(4, "0")}`,
      phoneDigits: `549110000${String(index).padStart(4, "0")}`,
      name: `Cliente ${index}`,
      matchingText: options.searchText,
      status: "NEW",
      assignmentStatus,
      attempts: assignmentStatus === "ADDED" ? 1 : 0,
      errorCode: null,
      errorMessage: null,
      sourceMessageCount: 1,
      strategy: "test"
    };
  }

  it("CASO 10: 41 contactos nuevos generan progreso 0/41 y luego 41/41", () => {
    const pending = Array.from({ length: 41 }, (_, index) => item(index + 1));
    expect(calculateMessageContactProgress(pending)).toMatchObject({ completed: 0, total: 41, percent: 0 });
    const added = pending.map((entry) => ({ ...entry, assignmentStatus: "ADDED" as const, attempts: 1 }));
    expect(calculateMessageContactProgress(added)).toMatchObject({ completed: 41, total: 41, percent: 100 });
    expect(recomputeMessageContactSummary(added, 41).added).toBe(41);
  });

  it("CASO 11: al pausar después de 19 confirmados, reanudar empieza por el contacto 20", () => {
    const checkpoint = Array.from({ length: 41 }, (_, index) => item(index + 1, index < 19 ? "ADDED" : "PENDING"));
    const pending = pendingMessageContactItems(checkpoint);
    expect(pending).toHaveLength(22);
    expect(pending[0]?.id).toBe("item-20");
    expect(pending.some((entry) => entry.id === "item-1")).toBe(false);
    expect(calculateMessageContactProgress(checkpoint)).toMatchObject({ completed: 19, total: 41, percent: 46 });
  });

  it("FAILED cuenta como procesado pero permanece explícito", () => {
    const checkpoint = [item(1, "ADDED"), item(2, "FAILED"), item(3, "PENDING")];
    expect(calculateMessageContactProgress(checkpoint)).toMatchObject({ completed: 2, total: 3, percent: 67 });
    expect(recomputeMessageContactSummary(checkpoint, 3)).toMatchObject({ added: 1, failed: 1 });
  });
});
