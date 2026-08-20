// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { outgoingPhotoMessages } from "../src/whatsapp/photo-evidence";

beforeEach(() => {
  document.body.innerHTML = "<div id='main'></div>";
});

describe("current WhatsApp outgoing photo evidence", () => {
  it("accepts an outgoing photo whose stable message data-id is an opaque ancestor id", () => {
    document.getElementById("main")!.innerHTML = `
      <div data-id="3A97F034BBAW753D524F">
        <div class="message-out">
          <div><img src="blob:sent-photo"></div>
        </div>
      </div>`;

    const photos = outgoingPhotoMessages();
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({
      identity: "3A97F034BBAW753D524F",
      stableIdentity: true
    });
  });

  it("accepts the historical serialized true_ data-id format", () => {
    document.getElementById("main")!.innerHTML = `
      <div class="message-out" data-id="true_5491112345678@c.us_MSG">
        <div data-testid="image-thumb"><img src="blob:sent-photo"></div>
      </div>`;

    const photos = outgoingPhotoMessages();
    expect(photos).toHaveLength(1);
    expect(photos[0]?.identity).toBe("true_5491112345678@c.us_MSG");
  });

  it("does not treat an outgoing sticker as a campaign photo", () => {
    document.getElementById("main")!.innerHTML = `
      <div data-id="3A97STICKER">
        <div class="message-out">
          <div data-testid="sticker"><img src="blob:sticker"></div>
        </div>
      </div>`;

    expect(outgoingPhotoMessages()).toEqual([]);
  });

  it("does not treat an emoji inside an outgoing text message as a photo", () => {
    document.getElementById("main")!.innerHTML = `
      <div data-id="3A97TEXT">
        <div class="message-out">
          <span class="selectable-text">Hola <img class="emoji" src="blob:emoji"></span>
        </div>
      </div>`;

    expect(outgoingPhotoMessages()).toEqual([]);
  });

  it("returns only the new photo when comparing stable ids before and after send", () => {
    document.getElementById("main")!.innerHTML = `
      <div data-id="OLDPHOTO"><div class="message-out"><img src="blob:old"></div></div>`;
    const before = new Set(outgoingPhotoMessages().filter((item) => item.stableIdentity).map((item) => item.identity));

    document.getElementById("main")!.insertAdjacentHTML(
      "beforeend",
      `<div data-id="NEWPHOTO"><div class="message-out"><img src="blob:new"></div></div>`
    );

    const newest = outgoingPhotoMessages().find((item) => item.stableIdentity && !before.has(item.identity));
    expect(newest?.identity).toBe("NEWPHOTO");
  });
});
