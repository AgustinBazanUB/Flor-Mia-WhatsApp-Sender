import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../src/contact-export/page.html", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/contact-export/page.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../src/background/message-contact-runtime.ts", import.meta.url), "utf8");
const mainWorld = readFileSync(new URL("../src/contact-export/whatsapp-message-search-main-world.ts", import.meta.url), "utf8");

describe("Paso 1.5 UI y wiring", () => {
  it("vive entre Paso 1 y Paso 2 y exige confirmación explícita", () => {
    const step1 = html.indexOf("Paso 1</span>");
    const step15 = html.indexOf("Paso 1.5");
    const step2 = html.indexOf("Paso 2</span>");
    expect(step1).toBeGreaterThanOrEqual(0);
    expect(step15).toBeGreaterThan(step1);
    expect(step2).toBeGreaterThan(step15);
    expect(html).toContain("Agregar contactos por frase");
    expect(html).toContain("Buscar contactos");
    expect(html).toContain("Solo mensajes recibidos por mí");
    expect(html).toContain("Contiene esta frase");
    expect(html).toContain("Mensaje exacto");
    expect(html).toContain("Actualizar lista");
    expect(html).toContain("Pausar");
    expect(html).toContain("Reanudar");
    expect(html).toContain("Cancelar");
  });

  it("muestra preview con teléfono, coincidencia y estado antes de asignar", () => {
    expect(html).toContain("<th>Teléfono</th><th>Coincidencia</th><th>Estado</th>");
    expect(page).toContain("messageAssignButton.disabled");
    expect(page).toContain("messageState?.status !== \"preview\"");
    expect(page).toContain("matchingText");
  });

  it("checkpoint y refresh están separados del extractor anterior", () => {
    expect(runtime).toContain("MessageContactStore");
    expect(runtime).toContain("ContactExportStore");
    expect(runtime).toContain("main-world-refresh-after-message-assignment");
    expect(runtime).toContain("pendingMessageContactItems");
    expect(mainWorld).toContain("main-world-global-msg-search");
    expect(mainWorld).toContain("addOrRemoveLabels");
    expect(mainWorld).toContain('type: "add"');
  });
});
