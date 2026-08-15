// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { waitForCondition } from "../src/whatsapp/wait";

describe("DOM wait helpers", () => {
  it("resolves from a mutation instead of a fixed sleep", async () => {
    document.body.innerHTML = "<main id='root'></main>";
    const promise = waitForCondition(() => document.querySelector("[data-ready='true']"), {
      timeoutMs: 200,
      description: "fixture readiness"
    });
    const ready = document.createElement("div");
    ready.dataset.ready = "true";
    document.getElementById("root")!.append(ready);
    await expect(promise).resolves.toBe(ready);
  });

  it("returns a typed timeout", async () => {
    document.body.innerHTML = "<main></main>";
    await expect(waitForCondition(() => null, { timeoutMs: 5, description: "un elemento imposible" })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
