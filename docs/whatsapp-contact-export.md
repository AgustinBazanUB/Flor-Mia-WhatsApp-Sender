# Exportación de contactos de WhatsApp Business — 0.9.5.3

## Objetivo

## Cambio principal de 0.9.5.3

Las pruebas reales de 0.9.5.2 demostraron dos límites del DOM: una etiqueta de 10 podía compartir un viewport con 19 filas visibles, y contactos identificados como `@lid` podían no exponer el teléfono en la fila. Por eso 0.9.5.3 cambia la fuente primaria de verdad.

El background ejecuta un inspector acotado en `world: MAIN` que **sólo lee estado ya cargado en la sesión de WhatsApp Web**. La integración está encapsulada en `whatsapp-main-world-resolver.ts` y usa, cuando existen, `WAWebCollections.Label`/`labelItemCollection` para obtener exactamente los chats vinculados a la etiqueta y `WAWebApiContact.getPhoneNumber` (más el mapa local equivalente cuando existe) para traducir un `@lid` a su JID telefónico. No se llama a endpoints HTTP privados, no se usa `Contact.find()`/fetch de red y no se abren conversaciones.

Estas estructuras son internas y no documentadas por WhatsApp: pueden cambiar. Si no están disponibles, el resolver devuelve `unsupported` y la extensión cae al adaptador DOM anterior, ahora más estricto. El fallback rechaza cualquier candidato visible que ya exceda el contador confiable de la etiqueta.


Flor Mía WhatsApp Sender incluye el módulo **Contactos de WhatsApp → Exportar contactos de WhatsApp**. En 9.5.1 el núcleo del extractor fue reemplazado por una estrategia **label-scoped + phone-first + no-chat-opening**.

La función no envía mensajes, no lee conversaciones y no reutiliza CampaignEngine. El sender conserva prioridad: si una campaña necesita manipular WhatsApp mientras existe un análisis, el Content Script cancela la extracción antes de abrir, enviar o reconciliar contenido.

## Problema corregido en 9.5.1

La implementación 0.9.5 podía producir un resultado como:

`Etiqueta con 10 contactos → 56 candidatos`

La auditoría encontró dos causas concretas en `whatsapp-contact-adapter.ts`:

1. después de hacer click en una etiqueta, el extractor aceptaba inmediatamente `#pane-side` como lista de contactos. Ese nodo también representa el listado global de chats y puede existir antes de que WhatsApp haya aplicado el filtro de la etiqueta;
2. cuando una fila no exponía teléfono/JID, el fallback hacía click en la fila, esperaba que cargara el chat y podía abrir la ficha del contacto para buscar el número.

El primer punto podía hacer que la extracción escapara de la etiqueta seleccionada. El segundo hacía el proceso lento y visual.

## Arquitectura actual

La implementación sigue separada en:

- `src/contact-export/whatsapp-main-world-resolver.ts`: fuente primaria encapsulada para membresía de etiquetas y mapeo local LID → teléfono;
- `src/contact-export/whatsapp-contact-adapter.ts`: fallback DOM centralizado; prueba el scope, recorre listas virtualizadas y resuelve teléfonos visibles/estructurados;
- `src/contact-export/phone-normalizer.ts`: valida fuentes internacionales/JID sin inventar país;
- `src/contact-export/contact-deduplicator.ts`: deduplica por teléfono y combina etiquetas seleccionadas;
- `src/contact-export/contact-export-store.ts`: estado temporal en `chrome.storage.session`;
- `src/background/contact-export-runtime.ts`: orquestación, scope/count diagnostics y estado;
- `src/background/contact-export-bootstrap.ts`: listener aislado del Service Worker de campañas;
- `src/contact-export/excel-exporter.ts`: XLSX local;
- `src/contact-export/contact-export-diagnostics.ts`: reporte saneado TXT/JSON;
- `src/contact-export/page.ts`: UI, preview y métricas.

## Regla de scope

Cada ejecución conserva `labelId`, `labelName` y, cuando WhatsApp lo aporta, `sourceId` y `countHint`.

Después de seleccionar una etiqueta el adaptador no acepta una lista sólo porque exista. Debe demostrar una relación entre el nombre exacto de la etiqueta activa y un listado contenido en ese estado. `#pane-side` sólo puede actuar como fallback si cambió respecto del listado previo y existe evidencia semántica de la etiqueta seleccionada.

Si no puede demostrar el contenedor:

`LABEL_CONTAINER_NOT_FOUND`

No recurre silenciosamente al listado global.

Si WhatsApp informa 10 contactos y se observan más de 10 identidades únicas:

`EXTRACTION_SCOPE_BROKEN`

El análisis termina ROJO y no exporta los elementos extra.

Si llega al final pero la cantidad final no coincide:

`LABEL_CONTACT_COUNT_MISMATCH`

Cuando WhatsApp no expone un contador confiable, la extracción puede terminar usando el final de scroll + estabilidad de IDs sin inventar una cantidad esperada.

## Phone-first

Un registro válido necesita teléfono. La resolución normal no abre la conversación.

Prioridad:

1. JID personal estructurado (`@c.us` / `@s.whatsapp.net`);
2. atributos semánticos de teléfono (`data-phone`, `data-phone-number`, `data-number`, `data-tel`);
3. enlaces locales confiables (`tel:`, `?phone=`, `wa.me/...`);
4. teléfono internacional visible que comience explícitamente con `+`;
5. `PHONE_UNRESOLVED`.

No se agrega `+54`, `9`, característica ni país por inferencia. Un número local ambiguo no se exporta como resuelto.

No se utiliza un número telefónico como nombre. Si WhatsApp muestra sólo el teléfono, `Nombre y Apellido` queda vacío.

## Sin apertura de chats

La ruta de análisis normal de 9.5.1 no contiene el fallback anterior de:

`fila → click → esperar chat → abrir ficha → leer teléfono`

La métrica `chatsOpened` del extractor normal es `0` por diseño. Si una fila no permite resolver el teléfono desde datos locales de la lista, queda en **Pendientes / No resueltos**.

No se implementó automáticamente un modo de “resolver pendientes abriendo chats”. Si se agrega en el futuro debe ser una acción manual separada.

## Listas virtualizadas

El DOM de WhatsApp puede contener sólo las filas visibles. El extractor:

1. identifica el contenedor de la etiqueta;
2. lee sólo filas de ese contenedor;
3. genera claves por teléfono, contactId estructurado o posición accesible estable;
4. agrega sólo claves nuevas;
5. desplaza únicamente el scrollRoot de la etiqueta;
6. vuelve a leer;
7. termina por countHint o por final + varias pasadas sin crecimiento;
8. aborta con `VIRTUAL_LIST_STALLED` si la lista deja de producir IDs nuevos sin llegar al final.

Existe un máximo de pasadas para evitar loops infinitos.

## Deduplicación y Zona

Prioridad de identidad:

1. teléfono normalizado;
2. contactId estructurado;
3. identidad posicional de la lista mientras se recolecta.

La exportación final deduplica por teléfono; nunca por nombre.

Para una sola etiqueta:

`Zona = labelName` literalmente.

Ejemplo: `Falta enviar` permanece exactamente `Falta enviar`.

Si el mismo teléfono aparece en varias etiquetas seleccionadas, se conserva una sola fila y `Zona` combina las etiquetas con ` | ` para mantener compatibilidad con el modelo actual de Clientes Fidelizados.

## Formato Excel

Hoja única: `Contactos`.

Columnas exactas:

| Telefono | Nombre y Apellido | Zona |
| --- | --- | --- |
| +5491123456789 | Juan Pérez | Zona Tribunales |
| +5491198765432 |  | Zona Tribunales |

El XLSX se genera localmente con SheetJS. No se usa un servicio externo.

## Métricas

La pantalla y el reporte registran:

- tiempo total;
- contactos por segundo;
- filas inspeccionadas;
- scrolls del contenedor de etiqueta;
- operaciones visuales;
- chats abiertos durante extracción normal;
- contador informado por etiqueta;
- únicos recolectados.

Estas métricas permiten comparar la sesión real sin inventar una mejora de velocidad basada sólo en tests.

## Diagnóstico 9.5.1

Errores relevantes:

- `LABELS_NOT_FOUND`
- `LABEL_NOT_FOUND`
- `LABEL_CONTAINER_NOT_FOUND`
- `LABEL_CONTACT_COUNT_MISMATCH`
- `CONTACT_ID_NOT_FOUND`
- `PHONE_UNRESOLVED`
- `PHONE_INVALID`
- `VIRTUAL_LIST_STALLED`
- `WHATSAPP_STRUCTURE_CHANGED`
- `EXTRACTION_SCOPE_BROKEN`
- `CONTACT_EXTRACTION_FAILED`
- `WHATSAPP_NOT_READY`
- `EXPORT_FAILED`
- `CONTACT_EXPORT_CANCELLED`

El módulo permite descargar reporte TXT o JSON. Incluye versión, feature, etiqueta, count informado/recolectado, último paso, paso fallido, estrategia, métricas, error y stack saneado.

No incluye nombres de contactos, teléfonos completos ni contenido de conversaciones.

## Estructuras internas y limitaciones

WhatsApp Web no ofrece una API pública estable para enumerar etiquetas y contactos. 0.9.5.3 usa de forma deliberada y encapsulada módulos internos **locales** de la sesión para resolver membresía y LID → teléfono, con fallback DOM. No utiliza endpoints privados de red ni servicios externos.

La consecuencia intencional es: si la fila contiene sólo un identificador opaco que no puede traducirse de manera confiable a teléfono desde la superficie disponible, se devuelve `PHONE_UNRESOLVED` en lugar de abrir automáticamente el chat o inventar información.

Un cambio futuro de WhatsApp puede exigir actualizar el adaptador. Los selectores/estrategias específicos están centralizados allí para evitar cambios dispersos.

## Privacidad

- No se usan servicios externos para extraer ni generar Excel.
- No se extraen mensajes.
- Resultados temporales: `chrome.storage.session`.
- No se guardan teléfonos/nombres de la exportación en el reporte técnico.

## Prueba real obligatoria

Los tests de DOM controlado no demuestran la estructura de una cuenta real de WhatsApp Business. Antes de una extracción grande se debe probar una etiqueta cuyo total sea conocido y verificar:

- count esperado = count recolectado;
- `Chats abiertos = 0`;
- teléfonos correctos;
- nombre opcional;
- Zona literal;
- pendientes sin teléfono informados;
- XLSX correcto;
- sender operativo después de la extracción.
