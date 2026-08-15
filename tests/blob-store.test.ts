import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { CampaignBlobStore } from "../src/storage/blob-store";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange, configurable: true });

describe("temporary campaign blob storage", () => {
  it("stores, lists, reads and removes local image blobs", async () => {
    const store = new CampaignBlobStore(new IDBFactory());
    await store.putCampaignImages("campaign-1", [
      { imageId: "image-2", order: 2, name: "dos.png", type: "image/png", blob: new Blob(["dos"], { type: "image/png" }) },
      { imageId: "image-1", order: 1, name: "uno.png", type: "image/png", blob: new Blob(["uno"], { type: "image/png" }) }
    ]);
    const images = await store.listCampaignImages("campaign-1");
    expect(images.map((item) => item.imageId)).toEqual(["image-1", "image-2"]);
    expect(await (await store.getImage("campaign-1", "image-1"))?.blob.text()).toBe("uno");
    expect(await store.deleteCampaign("campaign-1")).toBe(2);
    expect(await store.listCampaignImages("campaign-1")).toEqual([]);
  });
});
