# Flor Mía WhatsApp Sender 9.5.1 — Contact Export

## Motivo

9.5.1 reemplaza el núcleo del extractor de contactos 0.9.5. La versión anterior podía aceptar `#pane-side` como lista inmediatamente después de seleccionar una etiqueta, aunque ese nodo siguiera representando el listado global de chats. Además abría chats/fichas individualmente para intentar resolver teléfonos faltantes.

Efectos observados: extracción lenta y posible desborde de scope, por ejemplo una etiqueta de 10 contactos terminando con decenas de candidatos.

## Cambios

- extracción limitada a una etiqueta demostrablemente activa;
- rechazo de `#pane-side` sin evidencia de transición/scope;
- teléfono resuelto desde la fila, JID, atributos semánticos o enlaces locales confiables;
- cero aperturas de chat en el flujo normal;
- `PHONE_UNRESOLVED` para filas sin teléfono confiable;
- nombre opcional y vacío cuando WhatsApp muestra sólo el teléfono;
- Zona igual al nombre literal de la etiqueta;
- deduplicación por teléfono, con contactId/posición como claves temporales de recorrido;
- recorrido del scrollRoot de la etiqueta para listas virtualizadas;
- control de final y `VIRTUAL_LIST_STALLED`;
- validación de countHint cuando WhatsApp expone un contador;
- `EXTRACTION_SCOPE_BROKEN` si se superan los contactos informados;
- `LABEL_CONTACT_COUNT_MISMATCH` si el final no coincide con un contador confiable;
- métricas de tiempo, contactos/s, filas, scrolls, operaciones visuales y chats abiertos;
- reporte TXT y JSON saneado para Codex/ChatGPT;
- XLSX sin cambios: hoja `Contactos`, columnas `Telefono`, `Nombre y Apellido`, `Zona`.

## Seguridad y privacidad

No se usan endpoints privados de WhatsApp ni servicios externos. No se leen mensajes. Los resultados continúan en `chrome.storage.session` y el reporte no contiene nombres/teléfonos completos.

## Regresión del sender

La lógica de campañas no fue reemplazada. El sender mantiene prioridad y cancela una extracción activa antes de ejecutar navegación, proof, texto, imagen o reconciliación.

## Validación

La aceptación automática requiere `npm run verify` completo: typecheck, lint, tests, build y validate-build. La aceptación funcional de WhatsApp real requiere una prueba manual con una etiqueta cuyo total sea conocido, comprobando especialmente:

- cantidad exacta;
- `Chats abiertos = 0`;
- teléfonos correctos;
- Zona literal;
- pendientes sin teléfono;
- XLSX;
- sender operativo después.
