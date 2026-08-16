// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { describeCandidate, resolveCapability } from "../src/whatsapp/selectors";

describe("selector capability registry", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("uses the primary accessibility strategy when it works", () => {
    document.body.innerHTML = "<div aria-label='Chat list'></div>";
    const result = resolveCapability("main_interface", document, { required: true });
    expect(result.discovery.state).toBe("available");
    expect(result.discovery.selectedStrategy).toBe("main.accessibility.1");
    expect(result.discovery.attempts[0]).toMatchObject({ result: "matched", matchedCount: 1 });
  });

  it("uses a functional fallback after the primary strategies fail", () => {
    document.body.innerHTML = "<div data-testid='chat-list'></div>";
    const result = resolveCapability("main_interface", document, { required: true });
    expect(result.discovery.state).toBe("available");
    expect(result.discovery.selectedStrategy).toBe("main.testid.chat-list");
    expect(result.discovery.attempts.slice(0, 2).every((attempt) => attempt.result === "not_found")).toBe(true);
  });

  it("reports every exhausted strategy when none works", () => {
    const result = resolveCapability("attachment_action", document, { required: true });
    expect(result.discovery.state).toBe("unavailable");
    expect(result.discovery.selectedStrategy).toBeUndefined();
    expect(result.discovery.attempts.length).toBeGreaterThan(3);
    expect(result.discovery.attempts.every((attempt) => attempt.result === "not_found")).toBe(true);
  });

  it("sanitizes candidate summaries without text, names or complete phones", () => {
    document.body.innerHTML = `
      <section role="dialog"><button role="button" aria-label="Juan Pérez +5491112345678" data-testid="safe-action" data-icon="send">Mensaje privado completo</button></section>`;
    const candidate = describeCandidate(document.querySelector("button")!);
    expect(candidate).toMatchObject({
      tagName: "button",
      role: "button",
      ariaLabel: "[redacted]",
      dataTestId: "safe-action",
      dataIcon: "send"
    });
    expect(JSON.stringify(candidate)).not.toContain("5491112345678");
    expect(JSON.stringify(candidate)).not.toContain("Mensaje privado completo");
    expect(JSON.stringify(candidate)).not.toContain("Juan Pérez");
  });
});
