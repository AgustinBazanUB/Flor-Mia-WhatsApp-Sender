import { readFile, writeFile } from "node:fs/promises";

const path = "README.md";
let readme = await readFile(path, "utf8");
const marker = "## Contactos de WhatsApp — 0.9.6";
if (!readme.includes(marker)) {
  const release = `## Contactos de WhatsApp — 0.9.6\n\nLa release 0.9.6 agrega **Paso 1.5 · Agregar contactos por frase** entre la selección de etiquetas y el extractor existente. Usa la búsqueda global estructurada de WhatsApp Web, valida de forma literal \`contains\` / \`exact\`, excluye mensajes enviados por el usuario cuando \`Solo mensajes recibidos\` está activo, deduplica contactos y muestra una vista previa antes de modificar WhatsApp.\n\nAl confirmar, agrega únicamente los contactos \`NEW\`, verifica la membresía de cada chat, permite pausa/reanudación/cancelación con checkpoint y actualiza el contador de la etiqueta antes de continuar al Paso 2. No elimina otras etiquetas y no abre chat por chat para descubrir la frase.\n\nDocumentación: \`docs/add-contacts-by-message.md\` y \`docs/contact-export-release-notes-0.9.6.md\`.\n\n`;
  const firstSection = readme.indexOf("\n## ");
  readme = firstSection >= 0
    ? `${readme.slice(0, firstSection + 1)}${release}${readme.slice(firstSection + 1)}`
    : `${readme.trimEnd()}\n\n${release}`;
  await writeFile(path, readme, "utf8");
}
