// @vitest-environment jsdom
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


describe("Contact Export historical LID resolution", () => {
  it("resolves 210 structured LIDs from outgoing history receipts with no visual rows, scroll or server lookup", async () => {
    const ids = Array.from({ length: 210 }, (_, index) => `${String(800000000000000 + index)}@lid`);
    const chats = new Map<string, unknown>();
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index]!;
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
