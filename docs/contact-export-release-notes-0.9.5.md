# Contact Export 0.9.5 — reemplazado por 9.5.1

La primera implementación del módulo Contact Export quedó reemplazada por la arquitectura 9.5.1.

## Motivo

La auditoría posterior encontró que 0.9.5 podía aceptar `#pane-side` como lista inmediatamente después de seleccionar una etiqueta. Ese contenedor también podía seguir representando el listado global de chats, permitiendo escapar del scope seleccionado.

Además, cuando una fila no exponía un teléfono confiable, 0.9.5 intentaba resolverlo abriendo el chat y, en algunos casos, la ficha del contacto.

Esto explicaba:

- etiquetas pequeñas terminando con muchos candidatos externos;
- extracción lenta por navegación y esperas visuales contacto por contacto.

## Decisiones que se conservan

- módulo fuera de `CampaignEngine`;
- resultados sensibles sólo en `chrome.storage.session`;
- XLSX local con SheetJS;
- no endpoints privados de WhatsApp;
- no lectura de mensajes;
- deduplicación final por teléfono;
- Zona compatible con Clientes Fidelizados;
- sender con prioridad sobre una extracción activa.

## Reemplazo 9.5.1

Consultar:

- `docs/whatsapp-contact-export.md`
- `docs/contact-export-release-notes-9.5.1.md`

9.5.1 agrega extracción **label-scoped + phone-first + no-chat-opening**, recorrido virtualizado acotado, validación de cantidad y diagnóstico fail-closed cuando el scope no puede demostrarse.
