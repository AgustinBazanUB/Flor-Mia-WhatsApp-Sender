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
  "popup/user-facing.css",
  "popup/optimistic-controls.js",
  "contacts/index.html",
  "contacts/page.js",
  "contacts/page.css",
  "diagnostics/report.html",
  "diagnostics/report.js",
  "diagnostics/report.css"
];

for (const path of required) await access(resolve("dist", path));
const manifest = JSON.parse(await readFile(resolve("dist", "manifest.json"), "utf8"));
const sourceManifest = JSON.parse(await readFile(resolve("manifest.json"), "utf8"));
const packageMetadata = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(resolve("package-lock.json"), "utf8"));
const popupHtml = await readFile(resolve("dist", "popup/index.html"), "utf8");
const contactHtml = await readFile(resolve("dist", "contacts/index.html"), "utf8");
const contactPage = await readFile(resolve("dist", "contacts/page.js"), "utf8");
const whatsappContent = await readFile(resolve("dist", "content/whatsapp.js"), "utf8");
const optimisticControls = await readFile(resolve("dist", "popup/optimistic-controls.js"), "utf8");
if (manifest.manifest_version !== 3) throw new Error("El build no contiene Manifest V3.");
if (manifest.version !== sourceManifest.version) throw new Error("La versión del build no coincide con manifest.json.");
if (manifest.version_name !== sourceManifest.version_name) throw new Error("El nombre de versión del build no coincide con manifest.json.");
if (sourceManifest.version_name !== sourceManifest.version) {
  throw new Error("manifest.json debe mantener version y version_name coherentes para la versión visible en Chrome.");
}
if (sourceManifest.version !== packageMetadata.version) {
  throw new Error("La release de Contactos debe mantener manifest.json y package.json en la misma versión.");
}
if (packageLock.version !== packageMetadata.version || packageLock.packages?.[""]?.version !== packageMetadata.version) {
  throw new Error("package-lock.json y package.json deben mantener coherente la versión del workspace npm.");
}
if (sourceManifest.version !== "9.5.1") throw new Error("La release esperada para el extractor phone-first es 9.5.1.");
const optimisticScript = '<script src="./optimistic-controls.js"></script>';
const popupModule = '<script type="module" src="./popup.js"></script>';
const optimisticPosition = popupHtml.indexOf(optimisticScript);
const popupPosition = popupHtml.indexOf(popupModule);
if (optimisticPosition < 0 || popupPosition <= optimisticPosition) {
  throw new Error("El popup debe cargar optimistic-controls.js antes de popup.js.");
}
if (!optimisticControls.includes("../contacts/index.html") || !contactHtml.includes("Exportar Excel")) {
  throw new Error("El build no contiene el acceso o la página de exportación de contactos.");
}
if (!contactHtml.includes("PHONE_UNRESOLVED") || !contactHtml.includes("Chats abiertos") || !contactHtml.includes("codex-json")) {
  throw new Error("El build no contiene la UX de extracción phone-first y diagnóstico 9.5.1.");
}
if (!contactPage.includes("flormia_contact_export_diagnostic_") || !contactPage.includes("application/json")) {
  throw new Error("El build no contiene descarga de diagnóstico JSON para Contact Export.");
}
if (!whatsappContent.includes("label-scoped-phone-first-no-chat-opening")) {
  throw new Error("El Content Script no contiene la estrategia 9.5.1 label-scoped/phone-first.");
}
if (!optimisticControls.includes("Pausando…") || !optimisticControls.includes("Deteniendo…")) {
  throw new Error("El build no contiene la capa de confirmación inmediata para Pausa/Detener.");
}
const originPatterns = [
  ...(manifest.host_permissions || []),
  ...(manifest.optional_host_permissions || []),
  ...manifest.content_scripts.flatMap((item) => item.matches || [])
];
if (originPatterns.some((pattern) => pattern === "<all_urls>" || pattern === "*://*/*")) {
  throw new Error("El manifest solicita permisos globales.");
}
if (!manifest.host_permissions.includes("https://web.whatsapp.com/*")) throw new Error("Falta el permiso de WhatsApp Web.");
if (!manifest.host_permissions.includes("https://appintegralflormia.netlify.app/*")) {
  throw new Error("Falta el permiso acotado para la Web App Integral Flor Mía de producción.");
}
if (!manifest.host_permissions.includes("https://deploy-preview-7--appintegralflormia.netlify.app/*")) {
  throw new Error("Falta el permiso acotado para recuperar el bridge de Deploy Preview 7.");
}
const webAppScript = manifest.content_scripts.find((item) => item.js.includes("content/web-app-bridge.js"));
if (!webAppScript) throw new Error("Falta el puente de la Web-App.");
if (!webAppScript.matches?.includes("https://appintegralflormia.netlify.app/*")) {
  throw new Error("El bridge no se inyecta en la Web App Integral Flor Mía de producción.");
}
if (!manifest.permissions.includes("storage")) throw new Error("Falta el permiso de persistencia local.");
if (!manifest.permissions.includes("alarms")) throw new Error("Falta el permiso alarms requerido por el scheduler MV3.");
if (!manifest.permissions.includes("scripting")) throw new Error("Falta scripting requerido para recuperar Content Scripts tras recargar la extensión.");
const allowedExtensionPermissions = new Set(["storage", "alarms", "scripting"]);
if (manifest.permissions.some((permission) => !allowedExtensionPermissions.has(permission))) {
  throw new Error("El manifest contiene permisos de extensión no previstos.");
}
console.log(`Build validado: Flor Mía WhatsApp Sender ${manifest.version}, Manifest V3, sender y Contact Export phone-first presentes.`);