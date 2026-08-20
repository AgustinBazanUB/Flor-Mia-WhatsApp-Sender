// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { outgoingPhotoMessages, startCausalOutgoingPhotoObserver } from "../src/whatsapp/photo-evidence";

function flushMutations(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

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

  it("captures a transient outgoing data-id photo without requiring message-out", async () => {
    const main = document.getElementById("main")!;
    const observer = startCausalOutgoingPhotoObserver(main);
    const candidate = document.createElement("div");
    candidate.setAttribute("data-id", "true_current_photo");
    candidate.innerHTML = "<div data-testid='image-thumb'><img src='blob:current-photo'></div>";

    main.appendChild(candidate);
    candidate.remove();
    await flushMutations();

    const evidence = observer.take();
    expect(evidence).not.toBeNull();
    expect(evidence?.snapshot).toMatchObject({
      identity: "true_current_photo",
      stableIdentity: true
    });
    expect(observer.summary()).toMatchObject({
      photoObserved: true,
      stableIdObserved: true
    });
    observer.stop();
  });

  it("accepts a new msg-container photo when WhatsApp exposes an outgoing delivery mark", async () => {
    const main = document.getElementById("main")!;
    const observer = startCausalOutgoingPhotoObserver(main);
    const candidate = document.createElement("div");
    candidate.setAttribute("data-testid", "msg-container");
    candidate.innerHTML = `
      <div data-testid="image-thumb"><img src="blob:ack-photo"></div>
      <span data-icon="msg-check"></span>`;

    main.appendChild(candidate);
    await flushMutations();

    expect(observer.take()).toMatchObject({
      method: "causal-outgoing-photo-mutation",
      snapshot: { stableIdentity: false }
    });
    observer.stop();
  });

  it("does not accept an incoming-looking image container without an outgoing marker", async () => {
    const main = document.getElementById("main")!;
    const observer = startCausalOutgoingPhotoObserver(main);
    const candidate = document.createElement("div");
    candidate.setAttribute("data-testid", "msg-container");
    candidate.innerHTML = "<div data-testid='image-thumb'><img src='blob:incoming-photo'></div>";

    main.appendChild(candidate);
    await flushMutations();

    expect(observer.take()).toBeNull();
    expect(observer.summary().photoObserved).toBe(false);
    observer.stop();
  });

  it("recognizes a virtualized existing container when its outgoing id changes after the click", async () => {
    const main = document.getElementById("main")!;
    main.innerHTML = "<div data-testid='msg-container' data-id='true_old_text'><span class='selectable-text'>old</span></div>";
    const reused = main.querySelector<HTMLElement>("[data-testid='msg-container']")!;
    const observer = startCausalOutgoingPhotoObserver(main);

    reused.setAttribute("data-id", "true_new_photo");
    reused.innerHTML = "<div data-testid='image-thumb'><img src='blob:virtualized-photo'></div>";
    await flushMutations();

    expect(observer.take()).toMatchObject({
      snapshot: {
        identity: "true_new_photo",
        stableIdentity: true
      }
    });
    expect(outgoingPhotoMessages(main)).toHaveLength(1);
    observer.stop();
  });
});
