import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("popup campaign control UX", () => {
  it("loads the optimistic control layer before the popup module", async () => {
    const html = await readFile(resolve(root, "src/popup/index.html"), "utf8");
    const optimistic = html.indexOf('<script src="./optimistic-controls.js"></script>');
    const popup = html.indexOf('<script type="module" src="./popup.js"></script>');
    expect(optimistic).toBeGreaterThan(-1);
    expect(popup).toBeGreaterThan(optimistic);
  });

  it("acknowledges Pause and Stop immediately and blocks duplicate controls", async () => {
    const source = await readFile(resolve(root, "src/popup/optimistic-controls.js"), "utf8");
    expect(source).toContain("Pausando…");
    expect(source).toContain("Deteniendo…");
    expect(source).toContain('button.disabled = true');
    expect(source).toContain('aria-busy');
    expect(source).not.toContain("preventDefault");
    expect(source).not.toContain("stopPropagation");
  });

  it("keeps the technical state codes while presenting a stable stopping label", async () => {
    const css = await readFile(resolve(root, "src/popup/user-facing.css"), "utf8");
    expect(css).toContain(".campaign-status.is-stopping::after");
    expect(css).toContain('content: "Deteniendo…"');
    expect(css).toContain('content: "Necesita revisión"');
  });
});
