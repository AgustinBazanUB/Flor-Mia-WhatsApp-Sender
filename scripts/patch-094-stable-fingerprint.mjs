import { readFile, writeFile } from "node:fs/promises";

const path = "src/whatsapp/conversation-context.ts";
let source = await readFile(path, "utf8");
const from = `function conversationFingerprint(main: Element): string {\n  const header = main.querySelector("header");\n  const parts = [\n    safeFingerprintPart(header?.textContent),\n    safeFingerprintPart(header?.getAttribute("title")),\n    ...RECIPIENT_ATTRIBUTES.map((attribute) => safeFingerprintPart(header?.getAttribute(attribute))),\n    safeFingerprintPart(main.getAttribute("data-testid")),\n    safeFingerprintPart(main.getAttribute("role"))\n  ];\n  return fnv1a(parts.join("|"));\n}`;
const to = `function conversationFingerprint(main: Element): string {\n  const header = main.querySelector("header");\n  // No usar todo textContent: presencia/estado puede cambiar sin cambiar de contacto.\n  // Preferimos un título semántico estable y la estructura del header. El valor sólo\n  // se usa dentro del hash efímero de la lease y nunca se persiste.\n  const titled = header?.querySelector<HTMLElement>("[title]");\n  const stableTitle = titled?.getAttribute("title") || header?.getAttribute("title") || "";\n  const structure = header\n    ? [...header.children].slice(0, 12).map((child) => \`${'${'}child.tagName.toLowerCase()}:${'${'}child.getAttribute("role") ?? ""}:${'${'}child.getAttribute("data-testid") ?? ""}\`).join(",")\n    : "";\n  const parts = [\n    safeFingerprintPart(stableTitle),\n    safeFingerprintPart(structure),\n    ...RECIPIENT_ATTRIBUTES.map((attribute) => safeFingerprintPart(header?.getAttribute(attribute))),\n    safeFingerprintPart(main.getAttribute("data-testid")),\n    safeFingerprintPart(main.getAttribute("role"))\n  ];\n  return fnv1a(parts.join("|"));\n}`;
if (!source.includes(to)) {
  if (!source.includes(from)) throw new Error("conversationFingerprint source not found");
  source = source.replace(from, to);
  await writeFile(path, source);
}
