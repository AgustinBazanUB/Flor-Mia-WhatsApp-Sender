# Corte 0.9.5 — Contactos de WhatsApp

## Decisiones técnicas

- La funcionalidad se implementa fuera de `CampaignEngine` y fuera de la cola durable de campañas.
- El Service Worker histórico del sender no necesita conocer teléfonos/nombres exportados.
- El único punto compartido es el Content Script de WhatsApp. Si llega una acción de sender (`openConversation`, proof, send o reconcile), cualquier exportación activa se aborta antes de continuar.
- Datos sensibles del exportador se conservan únicamente en `chrome.storage.session`.
- El XLSX se genera localmente con SheetJS 0.18.5, empaquetado por esbuild; no se carga desde CDN.
- No se usan APIs privadas de WhatsApp ni contenido de mensajes.
- La capa de DOM está centralizada en `whatsapp-contact-adapter.ts`.
- Teléfonos locales ambiguos se rechazan; nunca se agrega un país por inferencia.
- Contactos repetidos se deduplican por teléfono normalizado.
- Múltiples etiquetas se conservan en una sola celda `Zona`, separadas con ` | `, porque Clientes Fidelizados modela una sola zona/cadena por cliente.
- La UI completa se abre como página interna `contacts/`; el popup sólo incorpora un acceso, evitando cargar SheetJS o tablas cuando se usa el sender.

## Archivos principales agregados

- `src/contact-export/types.ts`
- `src/contact-export/phone-normalizer.ts`
- `src/contact-export/contact-deduplicator.ts`
- `src/contact-export/whatsapp-contact-adapter.ts`
- `src/contact-export/contact-export-store.ts`
- `src/contact-export/excel-exporter.ts`
- `src/contact-export/contact-export-diagnostics.ts`
- `src/contact-export/page.html`
- `src/contact-export/page.css`
- `src/contact-export/page.ts`
- `src/background/contact-export-runtime.ts`
- `src/background/contact-export-bootstrap.ts`

## Archivos existentes modificados

- `src/shared/protocol.ts`
- `src/shared/errors.ts`
- `src/content/whatsapp.ts`
- `src/background/recovery-bootstrap.ts`
- `src/popup/optimistic-controls.js`
- `scripts/build.mjs`
- `scripts/validate-build.mjs`
- `package.json`
- `package-lock.json`
- `manifest.json`

## Riesgo que exige prueba manual

WhatsApp Web no ofrece un contrato DOM público estable para enumerar etiquetas/listas y todos sus contactos. Los tests verifican las estrategias con DOM controlado, pero la compatibilidad con la sesión real de Flor Mía debe probarse en Chrome antes de una exportación grande.
