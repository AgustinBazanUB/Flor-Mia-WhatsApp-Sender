// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ExtensionError } from "../src/shared/errors";
import {
  classifyComposerContent,
  normalizeComposerLineEndings,
  prepareComposerTextForSend
} from "../src/whatsapp/send-text";

function composer(text = ""): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("contenteditable", "true");
  element.textContent = text;
  document.body.replaceChildren(element);
  return element;
}

describe("idempotent WhatsApp text composer", () => {
  it("writes an empty composer exactly once", async () => {
    const element = composer();
    let inputEvents = 0;
    element.addEventListener("input", () => { inputEvents += 1; });

    await expect(prepareComposerTextForSend(element, "Hola, esto es una prueba 👋")).resolves.toBe("inserted");
    expect(normalizeComposerLineEndings(element.textContent ?? "")).toBe("Hola, esto es una prueba 👋");
    expect(inputEvents).toBe(1);
  });

  it("reuses a composer that already contains exactly the expected text", async () => {
    const element = composer("Hola, esto es una prueba 👋");
    let inputEvents = 0;
    element.addEventListener("input", () => { inputEvents += 1; });

    await expect(prepareComposerTextForSend(element, "Hola, esto es una prueba 👋")).resolves.toBe("reused");
    expect(element.textContent).toBe("Hola, esto es una prueba 👋");
    expect(inputEvents).toBe(0);
  });

  it("treats equivalent CRLF and LF line endings as the same prepared message", () => {
    expect(classifyComposerContent("Hola\r\nmundo", "Hola\nmundo")).toBe("prepared");
    expect(classifyComposerContent("Hola\rmundo", "Hola\nmundo")).toBe("prepared");
  });

  it("never overwrites a different user draft", async () => {
    const element = composer("Borrador del usuario");

    await expect(prepareComposerTextForSend(element, "Mensaje de campaña")).rejects.toMatchObject({
      name: "ExtensionError",
      details: { sendAttempted: false, draftConflict: true }
    } satisfies Partial<ExtensionError>);
    expect(element.textContent).toBe("Borrador del usuario");
  });

  it("retry after composer preparation does not append expected + expected", async () => {
    const element = composer();
    const expected = "Hola\nsegunda línea";

    await expect(prepareComposerTextForSend(element, expected)).resolves.toBe("inserted");
    await expect(prepareComposerTextForSend(element, expected)).resolves.toBe("reused");

    expect(normalizeComposerLineEndings(element.textContent ?? "")).toBe(expected);
    expect(element.textContent).not.toBe(`${expected}${expected}`);
  });
});
