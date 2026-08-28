import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("contact export popup entry", () => {
  it("adds one lightweight entry without loading XLSX in the popup", async () => {
    const source = await readFile("src/popup/optimistic-controls.js", "utf8");
    const popup = await readFile("src/popup/popup.ts", "utf8");
    expect(source).toContain("../contacts/index.html");
    expect(source).toContain("Exportar contactos de WhatsApp");
    expect(source).not.toContain("xlsx");
    expect(popup).not.toContain('from "xlsx"');
  });
});
