import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("contact export UI integration", () => {
  it("adds one lightweight popup entry without loading XLSX in the sender popup", async () => {
    const source = await readFile("src/popup/optimistic-controls.js", "utf8");
    const popup = await readFile("src/popup/popup.ts", "utf8");
    expect(source).toContain("../contacts/index.html");
    expect(source).toContain("Exportar contactos de WhatsApp");
    expect(source).not.toContain("xlsx");
    expect(popup).not.toContain('from "xlsx"');
  });

  it("exposes PHONE_UNRESOLVED, no-chat metrics and TXT/JSON diagnostics in the dedicated page", async () => {
    const html = await readFile("src/contact-export/page.html", "utf8");
    expect(html).toContain("PHONE_UNRESOLVED");
    expect(html).toContain("Chats abiertos");
    expect(html).toContain('id="codex-report"');
    expect(html).toContain('id="codex-json"');
  });
});
