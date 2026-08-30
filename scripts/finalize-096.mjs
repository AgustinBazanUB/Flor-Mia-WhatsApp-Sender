import { readFile, writeFile } from "node:fs/promises";

async function patchText(path, replacements) {
  let text = await readFile(path, "utf8");
  for (const [from, to] of replacements) {
    if (!text.includes(from)) throw new Error(`${path}: no se encontró el bloque esperado: ${from.slice(0, 80)}`);
    text = text.replace(from, to);
  }
  await writeFile(path, text, "utf8");
}

await patchText("src/background/message-contact-runtime.ts", [
  ['import { ContactExportStore } from "../contact-export/contact-export-store";', 'import type { ContactExportStore } from "../contact-export/contact-export-store";'],
  ['import { MessageContactStore } from "../contact-export/message-contact-store";', 'import type { MessageContactStore } from "../contact-export/message-contact-store";']
]);

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
manifest.version = "0.9.6";
manifest.version_name = "0.9.6";
await writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
packageJson.version = "0.9.6";
await writeFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
packageLock.version = "0.9.6";
if (packageLock.packages?.[""]) packageLock.packages[""].version = "0.9.6";
await writeFile("package-lock.json", `${JSON.stringify(packageLock, null, 2)}\n`, "utf8");

await patchText("scripts/validate-build.mjs", [
  ['if (sourceManifest.version !== "0.9.5.6") throw new Error("La release esperada para el extractor estructurado es 0.9.5.6.");', 'if (sourceManifest.version !== "0.9.6") throw new Error("La release esperada es 0.9.6.");'],
  ['if (!contactHtml.includes("PHONE_UNRESOLVED") || !contactHtml.includes("Chats abiertos") || !contactHtml.includes("codex-json")) {\n  throw new Error("El build no contiene la UX de extracción phone-first y diagnóstico 0.9.5.6.");\n}', 'if (!contactHtml.includes("PHONE_UNRESOLVED") || !contactHtml.includes("Chats abiertos") || !contactHtml.includes("codex-json")) {\n  throw new Error("El build no contiene la UX de extracción phone-first y diagnóstico 0.9.6.");\n}\nif (!contactHtml.includes("Paso 1.5") || !contactHtml.includes("Agregar contactos por frase") || !contactHtml.includes("Solo mensajes recibidos por mí") || !contactHtml.includes("Actualizar lista")) {\n  throw new Error("El build no contiene el Paso 1.5 Add Contacts By Message de 0.9.6.");\n}\nif (!contactPage.includes("MESSAGE_CONTACT_SEARCH") || !contactPage.includes("MESSAGE_CONTACT_ASSIGN") || !contactPage.includes("message-refresh-list")) {\n  throw new Error("La página de Contactos no contiene el protocolo del Paso 1.5 de 0.9.6.");\n}'],
  ['if (!backgroundWorker.includes("virtualized-lid-hydration") || !whatsappContent.includes("flormia_contact_export_lid_resolve_v1")) {\n  throw new Error("El build no contiene la hidratación virtualizada LID→teléfono de 0.9.5.6.");\n}', 'if (!backgroundWorker.includes("virtualized-lid-hydration") || !whatsappContent.includes("flormia_contact_export_lid_resolve_v1")) {\n  throw new Error("El build no contiene la hidratación virtualizada LID→teléfono heredada por 0.9.6.");\n}\nif (!backgroundWorker.includes("main-world-global-msg-search") || !backgroundWorker.includes("WAWebCollections") || !backgroundWorker.includes("LIST_ASSIGNMENT_NOT_CONFIRMED") || !backgroundWorker.includes("main-world-refresh-after-message-assignment")) {\n  throw new Error("El Service Worker no contiene búsqueda global, asignación verificada y refresh del Paso 1.5.");\n}'],
  ['console.log(`Build validado: Flor Mía WhatsApp Sender ${manifest.version}, Manifest V3, sender y Contact Export phone-first presentes.`);', 'console.log(`Build validado: Flor Mía WhatsApp Sender ${manifest.version}, Manifest V3, sender, Contact Export y Add Contacts By Message presentes.`);']
]);
