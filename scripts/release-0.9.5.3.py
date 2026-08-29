from pathlib import Path
import json

ROOT = Path('.')

# --- DOM fallback: never accept more visible rows than the reliable label count.
adapter = ROOT / 'src/contact-export/whatsapp-contact-adapter.ts'
s = adapter.read_text(encoding='utf-8')
old = '''  const grosslyOverExpected = expected != null && expected > 0 && rows.length > Math.max(expected * 2, expected + 12);\n'''
new = '''  const exceedsExpected = expected != null && rows.length > expected;\n'''
assert old in s, 'old DOM over-count threshold not found'
s = s.replace(old, new)
old = '''  else if (grosslyOverExpected) reason = 'grossly-over-reported-count';\n'''
new = '''  else if (exceedsExpected) reason = 'over-reported-count';\n'''
assert old in s, 'old DOM over-count reason not found'
s = s.replace(old, new)
adapter.write_text(s, encoding='utf-8')

# --- Runtime: structured local WhatsApp label store first; DOM only as fallback.
runtime = ROOT / 'src/background/contact-export-runtime.ts'
r = runtime.read_text(encoding='utf-8')
needle = 'import { deduplicateContactCandidates } from "../contact-export/contact-deduplicator";\n'
assert needle in r, 'dedupe import not found'
r = r.replace(needle, needle + 'import { collectContactsFromWhatsAppMainWorld } from "../contact-export/whatsapp-main-world-resolver";\n')
old_keys = '''  "collectedCount",\n  "candidateCount"\n] as const;'''
new_keys = '''  "collectedCount",\n  "candidateCount",\n  "internalChatCount",\n  "internalLabelIdPresent",\n  "mainWorldReason",\n  "resolvedPhones",\n  "unresolvedPhones"\n] as const;'''
assert old_keys in r, 'technical detail key block not found'
r = r.replace(old_keys, new_keys)
old_block = '''      const result = await this.transport.sendWhenContentReady(\n        INTERNAL_MESSAGE_TYPES.whatsappContactExportAnalyze,\n        { operationId, labels },\n        tab.id,\n        Math.max(60_000, labels.length * 60_000)\n      );'''
new_block = '''      const structured = await collectContactsFromWhatsAppMainWorld(tab.id, labels);\n      if (structured) {\n        await this.recordProgress({\n          operationId,\n          processed: structured.candidates.length,\n          totalHint: structured.labelResults.reduce((sum, item) => sum + (item.reportedCount ?? item.collectedUniqueContacts), 0) || null,\n          percent: 100,\n          currentLabel: labels.at(-1)?.name ?? null,\n          labelIndex: labels.length,\n          totalLabels: labels.length,\n          currentContact: structured.candidates.length,\n          metrics: structured.metrics,\n          labelResults: structured.labelResults\n        });\n      }\n      const result = structured\n        ? { candidates: structured.candidates, strategy: structured.strategy }\n        : await this.transport.sendWhenContentReady(\n            INTERNAL_MESSAGE_TYPES.whatsappContactExportAnalyze,\n            { operationId, labels },\n            tab.id,\n            Math.max(60_000, labels.length * 60_000)\n          );'''
assert old_block in r, 'contact export analyze transport block not found'
r = r.replace(old_block, new_block)
runtime.write_text(r, encoding='utf-8')

# --- Version metadata.
for filename in ['manifest.json', 'package.json', 'package-lock.json']:
    path = ROOT / filename
    data = json.loads(path.read_text(encoding='utf-8'))
    data['version'] = '0.9.5.3'
    if filename == 'manifest.json':
        data['version_name'] = '0.9.5.3'
    if filename == 'package-lock.json':
        data.setdefault('packages', {}).setdefault('', {})['version'] = '0.9.5.3'
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

# --- Build validation must prove the structured resolver is bundled.
validate = ROOT / 'scripts/validate-build.mjs'
v = validate.read_text(encoding='utf-8')
v = v.replace('sourceManifest.version !== "0.9.5.2"', 'sourceManifest.version !== "0.9.5.3"')
v = v.replace('La release esperada para el extractor phone-first es 9.5.1.', 'La release esperada para el extractor estructurado es 0.9.5.3.')
v = v.replace('diagnóstico 0.9.5.2.', 'diagnóstico 0.9.5.3.')
v = v.replace('estrategia 0.9.5.2 label-scoped/phone-first.', 'estrategia 0.9.5.3 label-scoped/phone-first.')
needle = '''const optimisticControls = await readFile(resolve("dist", "popup/optimistic-controls.js"), "utf8");\n'''
assert needle in v, 'build validator load section not found'
v = v.replace(needle, needle + 'const backgroundWorker = await readFile(resolve("dist", "background/service-worker.js"), "utf8");\n')
needle = '''if (!whatsappContent.includes("label-scoped-phone-first-no-chat-opening")) {\n  throw new Error("El Content Script no contiene la estrategia 0.9.5.3 label-scoped/phone-first.");\n}\n'''
assert needle in v, 'build validator phone-first assertion not found'
v = v.replace(needle, needle + '''if (!backgroundWorker.includes("WAWebCollections") || !backgroundWorker.includes("WAWebApiContact") || !backgroundWorker.includes("main-world-label-store+local-lid-map")) {\n  throw new Error("El build no contiene el resolver estructurado local de etiquetas/LID de 0.9.5.3.");\n}\n''')
validate.write_text(v, encoding='utf-8')

# --- README: reflect the new primary source of truth.
readme = ROOT / 'README.md'
rd = readme.read_text(encoding='utf-8')
rd = rd.replace('## Contactos de WhatsApp — 0.9.5.2', '## Contactos de WhatsApp — 0.9.5.3')
rd = rd.replace('La versión 0.9.5.2 mantiene el crawler visual anterior por una extracción **label-scoped + phone-first + no-chat-opening**:', 'La versión 0.9.5.3 usa como fuente primaria el **estado local estructurado de etiquetas/chats de WhatsApp** y deja el crawler DOM como fallback. Mantiene el enfoque **label-scoped + phone-first + no-chat-opening**:')
rd = rd.replace('- sólo procesa un listado que pueda vincularse a la etiqueta seleccionada;\n- prioriza JID/atributos/enlaces locales estructurados para resolver teléfono;', '- obtiene primero la membresía exacta desde la colección local de la etiqueta cuando está disponible;\n- resuelve JID telefónico directo y mapea IDs `@lid` al teléfono mediante datos/módulos locales ya cargados por WhatsApp;\n- si esa integración interna no está disponible, usa el adaptador DOM estricto como fallback;')
rd = rd.replace('Contact Export 0.9.5.2 deliberadamente deja pendientes las filas cuyo teléfono no puede resolverse sin abrir el chat.', 'Contact Export 0.9.5.3 deja pendiente únicamente un contacto cuyo teléfono no pueda resolverse ni por la colección local/JID-LID ni por los fallbacks estructurados, sin abrir el chat.')
readme.write_text(rd, encoding='utf-8')

# --- Main documentation: add the 0.9.5.3 architectural decision without erasing history.
doc = ROOT / 'docs/whatsapp-contact-export.md'
d = doc.read_text(encoding='utf-8')
d = d.replace('# Exportación de contactos de WhatsApp Business — 9.5.1', '# Exportación de contactos de WhatsApp Business — 0.9.5.3')
marker = '## Objetivo\n'
assert marker in d, 'documentation objective marker not found'
insert = '''## Cambio principal de 0.9.5.3\n\nLas pruebas reales de 0.9.5.2 demostraron dos límites del DOM: una etiqueta de 10 podía compartir un viewport con 19 filas visibles, y contactos identificados como `@lid` podían no exponer el teléfono en la fila. Por eso 0.9.5.3 cambia la fuente primaria de verdad.\n\nEl background ejecuta un inspector acotado en `world: MAIN` que **sólo lee estado ya cargado en la sesión de WhatsApp Web**. La integración está encapsulada en `whatsapp-main-world-resolver.ts` y usa, cuando existen, `WAWebCollections.Label`/`labelItemCollection` para obtener exactamente los chats vinculados a la etiqueta y `WAWebApiContact.getPhoneNumber` (más el mapa local equivalente cuando existe) para traducir un `@lid` a su JID telefónico. No se llama a endpoints HTTP privados, no se usa `Contact.find()`/fetch de red y no se abren conversaciones.\n\nEstas estructuras son internas y no documentadas por WhatsApp: pueden cambiar. Si no están disponibles, el resolver devuelve `unsupported` y la extensión cae al adaptador DOM anterior, ahora más estricto. El fallback rechaza cualquier candidato visible que ya exceda el contador confiable de la etiqueta.\n\n'''
d = d.replace(marker, marker + '\n' + insert, 1)
d = d.replace('## Arquitectura 9.5.1', '## Arquitectura actual')
d = d.replace('- `src/contact-export/whatsapp-contact-adapter.ts`: única capa que conoce el DOM de WhatsApp; prueba el scope de etiqueta, recorre listas virtualizadas y resuelve teléfonos desde la fila;', '- `src/contact-export/whatsapp-main-world-resolver.ts`: fuente primaria encapsulada para membresía de etiquetas y mapeo local LID → teléfono;\n- `src/contact-export/whatsapp-contact-adapter.ts`: fallback DOM centralizado; prueba el scope, recorre listas virtualizadas y resuelve teléfonos visibles/estructurados;')
old_limit = 'WhatsApp Web no ofrece una API pública estable para enumerar etiquetas y contactos. 9.5.1 utiliza únicamente información disponible localmente en la UI/DOM accesible a la extensión y no se engancha a módulos privados de webpack ni endpoints internos no documentados.'
if old_limit in d:
    d = d.replace(old_limit, 'WhatsApp Web no ofrece una API pública estable para enumerar etiquetas y contactos. 0.9.5.3 usa de forma deliberada y encapsulada módulos internos **locales** de la sesión para resolver membresía y LID → teléfono, con fallback DOM. No utiliza endpoints privados de red ni servicios externos.')
doc.write_text(d, encoding='utf-8')

print('Applied Contact Export 0.9.5.3 structured-label/LID resolver integration')
