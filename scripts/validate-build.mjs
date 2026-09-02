import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const required = [
  "manifest.json",
  "background/service-worker.js",
  "content/whatsapp.js",
  "content/inbox-runtime.js",
  "content/web-app-bridge.js",
  "content/inbox-web-app-bridge.js",
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
const inboxContent = await readFile(resolve("dist", "content/inbox-runtime.js"), "utf8");
const inboxBridge = await readFile(resolve("dist", "content/inbox-web-app-bridge.js"), "utf8");
const optimisticControls = await readFile(resolve("dist", "popup/optimistic-controls.js"), "utf8");
const backgroundWorker = await readFile(resolve("dist", "background/service-worker.js"), "utf8");
if (manifest.manifest_version !== 3) throw new Error("El build no contiene Manifest V3.");
if (manifest.version !== sourceManifest.version) throw new Error("La versión del build no coincide con manifest.json.");
if (manifest.version_name !== sourceManifest.version_name) throw new Error("El nombre de versión del build no coincide con manifest.json.");
if (sourceManifest.version_name !== sourceManifest.version) throw new Error("manifest.json debe mantener version y version_name coherentes para la versión visible en Chrome.");
if (sourceManifest.version !== packageMetadata.version) throw new Error("La release de Contactos debe mantener manifest.json y package.json en la misma versión.");
if (packageLock.version !== packageMetadata.version || packageLock.packages?.[""]?.version !== packageMetadata.version) throw new Error("package-lock.json y package.json deben mantener coherente la versión del workspace npm.");
if (sourceManifest.version !== "0.9.6") throw new Error("La release esperada es 0.9.6.");

const optimisticScript = '<script src="./optimistic-controls.js"></script>';
const popupModule = '<script type="module" src="./popup.js"></script>';
const optimisticPosition = popupHtml.indexOf(optimisticScript);
const popupPosition = popupHtml.indexOf(popupModule);
if (optimisticPosition < 0 || popupPosition <= optimisticPosition) throw new Error("El popup debe cargar optimistic-controls.js antes de popup.js.");
if (!optimisticControls.includes("../contacts/index.html") || !contactHtml.includes("Exportar Excel")) throw new Error("El build no contiene el acceso o la página de exportación de contactos.");
if (!contactHtml.includes("PHONE_UNRESOLVED") || !contactHtml.includes("Chats abiertos") || !contactHtml.includes("codex-json")) throw new Error("El build no contiene la UX de extracción phone-first y diagnóstico 0.9.6.");
if (!contactHtml.includes("Paso 1.5") || !contactHtml.includes("Agregar contactos por frase") || !contactHtml.includes("Solo mensajes recibidos por mí") || !contactHtml.includes("Actualizar lista")) throw new Error("El build no contiene el Paso 1.5 Add Contacts By Message de 0.9.6.");
if (!contactPage.includes("MESSAGE_CONTACT_SEARCH") || !contactPage.includes("MESSAGE_CONTACT_ASSIGN") || !contactPage.includes("message-refresh-list")) throw new Error("La página de Contactos no contiene el protocolo del Paso 1.5 de 0.9.6.");
if (!contactPage.includes("flormia_contact_export_diagnostic_") || !contactPage.includes("application/json")) throw new Error("El build no contiene descarga de diagnóstico JSON para Contact Export.");
if (!whatsappContent.includes("label-scoped-phone-first-no-chat-opening")) throw new Error("El Content Script no contiene la estrategia 0.9.5.6 label-scoped/phone-first.");
if (!backgroundWorker.includes("WAWebCollections") || !backgroundWorker.includes("WAWebApiContact") || !backgroundWorker.includes("main-world-label-store+local-lid-map")) throw new Error("El build no contiene el resolver estructurado local de etiquetas/LID de 0.9.5.6.");
if (!backgroundWorker.includes("message-user-receipt") || !backgroundWorker.includes("history-metadata-lid-map") || !backgroundWorker.includes("phoneLookupServerSkipped") || !backgroundWorker.includes("model-storage") || !backgroundWorker.includes("phoneHistoryIndexedDbMessagesScanned")) throw new Error("El build no contiene la correlación histórica LID→PN no visual de 0.9.5.6.");
if (!backgroundWorker.includes("virtualized-lid-hydration") || !whatsappContent.includes("flormia_contact_export_lid_resolve_v1")) throw new Error("El build no contiene la hidratación virtualizada LID→teléfono heredada por 0.9.6.");
if (!backgroundWorker.includes("main-world-global-msg-search") || !backgroundWorker.includes("WAWebCollections") || !backgroundWorker.includes("LIST_ASSIGNMENT_NOT_CONFIRMED") || !backgroundWorker.includes("main-world-refresh-after-message-assignment")) throw new Error("El Service Worker no contiene búsqueda global, asignación verificada y refresh del Paso 1.5.");
if (!optimisticControls.includes("Pausando…") || !optimisticControls.includes("Deteniendo…")) throw new Error("El build no contiene la capa de confirmación inmediata para Pausa/Detener.");
if (!inboxContent.includes("flor_mia_whatsapp_inbox_internal") || !inboxBridge.includes("flor_mia_whatsapp_inbox_extension")) throw new Error("El build no contiene el protocolo aislado del WhatsApp Inbox.");
if (!backgroundWorker.includes("whatsappInboxSendCacheV1") || !backgroundWorker.includes("OPERATION_CONFLICT")) throw new Error("El build no contiene idempotencia o coordinación de operaciones del WhatsApp Inbox.");

const originPatterns = [
  ...(manifest.host_permissions || []),
  ...(manifest.optional_host_permissions || []),
  ...manifest.content_scripts.flatMap((item) => item.matches || [])
];
if (originPatterns.some((pattern) => pattern === "<all_urls>" || pattern === "*://*/*")) throw new Error("El manifest solicita permisos globales.");
if (!manifest.host_permissions.includes("https://web.whatsapp.com/*")) throw new Error("Falta el permiso de WhatsApp Web.");
if (!manifest.host_permissions.includes("https://appintegralflormia.netlify.app/*")) throw new Error("Falta el permiso acotado para la Web App Integral Flor Mía de producción.");
if (manifest.host_permissions.includes("https://*.netlify.app/*")) throw new Error("El permiso host no debe ampliarse a todos los sitios Netlify.");
const webAppScript = manifest.content_scripts.find((item) => item.js.includes("content/web-app-bridge.js"));
if (!webAppScript) throw new Error("Falta el puente de la Web-App.");
if (!webAppScript.matches?.includes("https://appintegralflormia.netlify.app/*")) throw new Error("El bridge no se inyecta en la Web App Integral Flor Mía de producción.");
if (webAppScript.matches?.includes("https://*.netlify.app/*")) throw new Error("El bridge no debe declarar un match global para todos los sitios Netlify.");
if (webAppScript.include_globs?.length) throw new Error("El build base no necesita include_globs: los Deploy Previews se autorizan por origen exacto al compilar.");
for (const pattern of webAppScript.matches || []) {
  if (pattern.includes("netlify.app") && !pattern.startsWith("https://appintegralflormia.netlify.app/") && !pattern.startsWith("https://app-integral-fm.netlify.app/") && !/^https:\/\/deploy-preview-\d+--(?:appintegralflormia|app-integral-fm)\.netlify\.app\/\*$/.test(pattern)) {
    throw new Error(`El build contiene un origen Netlify no autorizado: ${pattern}`);
  }
}
if (!manifest.permissions.includes("storage")) throw new Error("Falta el permiso de persistencia local.");
if (!manifest.permissions.includes("alarms")) throw new Error("Falta el permiso alarms requerido por el scheduler MV3.");
if (!manifest.permissions.includes("scripting")) throw new Error("Falta scripting requerido para recuperar Content Scripts tras recargar la extensión.");
const allowedExtensionPermissions = new Set(["storage", "alarms", "scripting"]);
if (manifest.permissions.some((permission) => !allowedExtensionPermissions.has(permission))) throw new Error("El manifest contiene permisos de extensión no previstos.");
console.log(`Build validado: Flor Mía WhatsApp Sender ${manifest.version}, Manifest V3, sender, Contact Export, Add Contacts By Message, WhatsApp Inbox y orígenes exactos presentes.`);
