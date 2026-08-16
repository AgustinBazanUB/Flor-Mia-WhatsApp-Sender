import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const required = [
  "manifest.json",
  "background/service-worker.js",
  "content/whatsapp.js",
  "content/web-app-bridge.js",
  "popup/index.html",
  "popup/popup.js",
  "popup/popup.css",
  "diagnostics/report.html",
  "diagnostics/report.js",
  "diagnostics/report.css"
];

for (const path of required) await access(resolve("dist", path));
const manifest = JSON.parse(await readFile(resolve("dist", "manifest.json"), "utf8"));
const sourceManifest = JSON.parse(await readFile(resolve("manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("El build no contiene Manifest V3.");
if (manifest.version !== sourceManifest.version) throw new Error("La versión del build no coincide con manifest.json.");
const originPatterns = [
  ...(manifest.host_permissions || []),
  ...(manifest.optional_host_permissions || []),
  ...manifest.content_scripts.flatMap((item) => item.matches || [])
];
if (originPatterns.some((pattern) => pattern === "<all_urls>" || pattern === "*://*/*")) {
  throw new Error("El manifest solicita permisos globales.");
}
if (!manifest.host_permissions.includes("https://web.whatsapp.com/*")) throw new Error("Falta el permiso de WhatsApp Web.");
if (!manifest.permissions.includes("storage")) throw new Error("Falta el permiso de persistencia local.");
if (!manifest.permissions.includes("alarms")) throw new Error("Falta el permiso alarms requerido por el scheduler MV3.");
if (manifest.permissions.some((permission) => !["storage", "alarms"].includes(permission))) {
  throw new Error("El manifest contiene permisos de extensión no previstos.");
}
if (!manifest.content_scripts.some((item) => item.js.includes("content/web-app-bridge.js"))) throw new Error("Falta el puente de la Web-App.");
console.log("Build validado: Manifest V3 y artefactos requeridos presentes.");
