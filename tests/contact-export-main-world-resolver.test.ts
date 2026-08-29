// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectWhatsAppLabelsMainWorld,
  mainWorldSnapshotToCollection,
  type MainWorldContactExportSnapshot
} from "../src/contact-export/whatsapp-main-world-resolver";
import { resolveLabelScopedView } from "../src/contact-export/whatsapp-contact-adapter";
import type { WhatsAppLabelInfo } from "../src/contact-export/types";

function label(countHint = 10): WhatsAppLabelInfo {
  return {
    id: "ui-label-falta-enviar",
    name: "Falta Enviar",
    countHint,
    countHintStrategy: "dedicated-count",
    sourceId: null,
    strategy: "semantic-label-hub"
  };
}

function serialized(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "_serialized" in value) {
    return String((value as { _serialized?: unknown })._serialized ?? "");
  }
  return "";
}

function installLocalStore(): void {
  const ids = [
    ...Array.from({ length: 9 }, (_, index) => `54911000000${index}@c.us`),
    "123456789012345@lid"
  ];
  const contacts = new Map(ids.map((id, index) => [id, {
    id: { _serialized: id },
    name: index === 9 ? "Cliente LID" : `Cliente ${index}`
  }]));
  const labelModel = {
    id: "internal-label-7",
    name: "Falta Enviar",
    labelItemCollection: {
      getModelsArray: () => ids.map((id) => ({ parentType: "Chat", parentId: { _serialized: id, server: id.endsWith("@lid") ? "lid" : "c.us" } }))
    },
    serialize: () => ({ id: "internal-label-7", name: "Falta Enviar" })
  };
  const requireFn = (moduleName: string): unknown => {
    if (moduleName === "WAWebCollections") {
      return {
        Label: { getModelsArray: () => [labelModel] },
        Chat: {
          get: (id: unknown) => {
            const key = serialized(id);
            const contact = contacts.get(key);
            return contact ? { id: { _serialized: key }, formattedTitle: contact.name, contact } : undefined;
          }
        },
        Contact: { get: (id: unknown) => contacts.get(serialized(id)) }
      };
    }
    if (moduleName === "WAWebWidFactory") {
      return {
        createWid: (id: string) => ({ _serialized: id, server: id.endsWith("@lid") ? "lid" : "c.us" })
      };
    }
    if (moduleName === "WAWebApiContact") {
      return {
        getPhoneNumber: (wid: unknown) => serialized(wid).endsWith("@lid")
          ? { _serialized: "5491199999999@c.us", server: "c.us" }
          : wid
      };
    }
    throw new Error(`unknown module ${moduleName}`);
  };
  Object.defineProperty(window, "require", { configurable: true, value: requireFn });
}

function setScrollGeometry(element: HTMLElement, clientHeight: number, scrollHeight: number): void {
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
}

afterEach(() => {
  delete (window as unknown as { require?: unknown }).require;
  delete (window as unknown as { Store?: unknown }).Store;
  document.body.innerHTML = "";
});

describe("Contact Export main-world local store resolver", () => {
  it("gets the exact ten chats from the label store and maps a LID to its phone without opening a chat", async () => {
    installLocalStore();
    const snapshot = await inspectWhatsAppLabelsMainWorld(["Falta Enviar"]);
    expect(snapshot.supported).toBe(true);
    expect(snapshot.labels).toHaveLength(1);
    expect(snapshot.labels[0]?.chatCount).toBe(10);
    expect(snapshot.labels[0]?.entries).toHaveLength(10);
    expect(snapshot.labels[0]?.entries.find((entry) => entry.chatId.endsWith("@lid"))).toMatchObject({
      phoneJid: "5491199999999@c.us",
      name: "Cliente LID",
      phoneResolution: "lid-map",
      kind: "contact"
    });

    const collection = mainWorldSnapshotToCollection(snapshot, [label()]);
    expect(collection?.strategy).toBe("main-world-label-store+local-lid-map");
    expect(collection?.candidates).toHaveLength(10);
    expect(collection?.labelResults[0]).toMatchObject({
      reportedCount: 10,
      collectedUniqueContacts: 10,
      resolvedPhones: 10,
      unresolvedPhones: 0,
      scrollOperations: 0
    });
    expect(collection?.metrics.chatsOpened).toBe(0);
    expect(collection?.metrics.visualOperations).toBe(0);
  });

  it("returns unsupported so the DOM fallback can run when WhatsApp local modules are unavailable", async () => {
    const snapshot = await inspectWhatsAppLabelsMainWorld(["Falta Enviar"]);
    expect(snapshot).toMatchObject({ supported: false, labels: [] });
  });

  it("fails closed when the local label store count disagrees with the reliable UI count", () => {
    const snapshot: MainWorldContactExportSnapshot = {
      supported: true,
      reason: null,
      labels: [{
        requestedName: "Falta Enviar",
        found: true,
        internalLabelId: "internal-label-7",
        chatCount: 9,
        entries: []
      }]
    };
    expect(() => mainWorldSnapshotToCollection(snapshot, [label(10)])).toThrowError(/cantidad estructurada/i);
    try {
      mainWorldSnapshotToCollection(snapshot, [label(10)]);
    } catch (error) {
      expect(error).toMatchObject({
        code: "ELEMENT_NOT_FOUND",
        details: expect.objectContaining({
          contactExportCode: "LABEL_CONTACT_COUNT_MISMATCH",
          stage: "main_world_label_count_validation",
          expectedCount: 10,
          collectedCount: 9
        })
      });
    }
  });

  it("keeps non-contact label items classifiable instead of turning them into phone contacts", async () => {
    const labelModel = {
      id: "internal-label",
      name: "Falta Enviar",
      labelItemCollection: {
        getModelsArray: () => [{ parentType: "Chat", parentId: { _serialized: "120363001234567890@g.us", server: "g.us" } }]
      }
    };
    Object.defineProperty(window, "require", {
      configurable: true,
      value: (moduleName: string) => moduleName === "WAWebCollections"
        ? { Label: { getModelsArray: () => [labelModel] }, Chat: { get: () => ({ formattedTitle: "Grupo" }) }, Contact: { get: () => undefined } }
        : moduleName === "WAWebWidFactory"
          ? { createWid: (id: string) => ({ _serialized: id, server: "g.us" }) }
          : {}
    });
    const snapshot = await inspectWhatsAppLabelsMainWorld(["Falta Enviar"]);
    expect(snapshot.labels[0]?.entries[0]).toMatchObject({ kind: "group", phoneJid: null });
  });

  it("rejects the 19-row DOM candidate when WhatsApp reports ten contacts", () => {
    document.body.innerHTML = `
      <section id="shell">
        <div id="marker" aria-selected="true" title="Falta Enviar">Falta Enviar</div>
        <div id="pane-side" role="list"></div>
      </section>`;
    const pane = document.getElementById("pane-side")!;
    pane.innerHTML = Array.from({ length: 19 }, (_, index) =>
      `<div role="listitem" data-index="${index}"><span title="Fila ${index}">Fila ${index}</span></div>`
    ).join("");
    setScrollGeometry(pane, 727, 1367);
    const view = resolveLabelScopedView(label(10), "different-before-fingerprint");
    expect(view).toBeNull();
  });
});
