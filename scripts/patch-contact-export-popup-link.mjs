import { readFile, writeFile } from "node:fs/promises";

const path = "src/popup/index.html";
let source = await readFile(path, "utf8");
const marker = `      <section id="campaign-card" class="card campaign-card" aria-live="polite">`;
const block = `      <section class="card contact-entry-card">\n        <div class="campaign-heading">\n          <div>\n            <span class="eyebrow">Contactos</span>\n            <h2>Contactos de WhatsApp</h2>\n          </div>\n        </div>\n        <p>Detectá etiquetas o listas de WhatsApp Business y prepará un Excel con teléfono, nombre y zona.</p>\n        <a class="button button--secondary button--wide" href="../contacts/index.html" target="_blank" rel="noopener">Exportar contactos de WhatsApp</a>\n      </section>\n\n`;
if (!source.includes(block)) {
  if (!source.includes(marker)) throw new Error("Campaign card marker not found");
  source = source.replace(marker, `${block}${marker}`);
  await writeFile(path, source);
}
