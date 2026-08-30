# Add Contacts By Message — Flor Mía WhatsApp Sender 0.9.6

## Objetivo

La versión 0.9.6 agrega un paso intermedio dentro de **Contactos → Exportar contactos de WhatsApp**:

1. Paso 1 — seleccionar una lista/etiqueta.
2. **Paso 1.5 — Agregar contactos por frase.**
3. Paso 2 — analizar/exportar contactos con el extractor existente.

El Paso 1.5 permite buscar una frase en el índice global de mensajes de WhatsApp Web, identificar contactos individuales únicos, comprobar si ya pertenecen a la lista seleccionada, mostrar una vista previa y agregar únicamente los nuevos después de una confirmación explícita.

## Principios de diseño

- No abre chat por chat para descubrir la frase.
- No recorre el historial completo de cada conversación.
- No utiliza IA ni coincidencia semántica.
- La búsqueda y validación se realizan localmente dentro de la pestaña de WhatsApp Web.
- La mutación de etiquetas sólo se ejecuta después de la confirmación del usuario.
- Una asignación sólo queda como `ADDED` si la membresía se puede volver a comprobar.
- No se eliminan otras etiquetas del contacto.
- El flujo previo de Contact Export 0.9.5.6 se conserva como Paso 2.

## Arquitectura

### 1. MessageSearchAdapter

Archivo principal:

- `src/contact-export/whatsapp-message-search-main-world.ts`

La búsqueda estructurada se ejecuta en `world: "MAIN"` mediante `chrome.scripting.executeScript`.

La estrategia primaria utiliza el mismo modelo local que alimenta la búsqueda global de WhatsApp Web:

- `WAWebCollections.Msg.search(...)` para obtener resultados globales;
- `WAWebCollections.Chat` / `Contact` para identidad y nombre;
- `WAWebCollections.Label` para membresía y asignación de etiquetas.

No se automatiza el click visual del buscador ni se abren conversaciones para descubrir coincidencias.

### 2. Validación determinística

Archivo:

- `src/contact-export/add-contacts-by-message.ts`

`matchesSearchRule(messageText, searchText, mode)` vuelve a comprobar cada mensaje.

Modos:

- `contains`: el texto normalizado con NFC + `trim()` debe contener literalmente la frase;
- `exact`: el texto normalizado con NFC + `trim()` debe ser igual a la frase.

No se cambia mayúsculas/minúsculas, no se tokeniza y no se aplican aproximaciones semánticas.

### 3. Received-only

Por defecto `inboundOnly = true`.

La dirección se obtiene de campos estructurados de identidad del mensaje (`id.fromMe` / equivalentes serializados).

- `fromMe === false`: recibido, puede continuar;
- `fromMe === true`: enviado por el usuario, se excluye;
- dirección desconocida: se excluye de forma fail-closed y se contabiliza en diagnóstico.

### 4. Exclusión de no-clientes

Se clasifican y se pueden excluir:

- grupos (`@g.us`);
- comunidades (flags estructurados de chat);
- canales (`@newsletter`);
- estados (`status@broadcast`);
- broadcast/sistema.

El objetivo es mantener únicamente conversaciones individuales válidas.

### 5. Deduplicación

Prioridad de identidad:

1. teléfono normalizado;
2. `contactId` estable;
3. `chatId` estable.

Nunca se deduplica sólo por nombre.

Si un mismo contacto aparece 3, 20 o más veces, la vista previa mantiene un solo registro y conserva `sourceMessageCount` como contador interno.

### 6. Resolución de teléfono

La búsqueda intenta resolver PN/JID directamente desde Chat/Contact.

Cuando el resultado es `@lid` sin teléfono, el runtime reutiliza el resolver existente de Contact Export 0.9.5.6:

- caches LID→PN;
- metadatos locales;
- historial estructurado;
- fallback read-only ya existente.

No se duplicó ese subsistema.

### 7. ListMembershipChecker

La membresía actual se obtiene del `labelItemCollection` de la etiqueta seleccionada.

Estados de preview:

- `NEW`;
- `ALREADY_IN_LIST`;
- `UNRESOLVED`.

Un contacto `ALREADY_IN_LIST` nunca entra a la cola de asignación.

### 8. Confirmación y asignación

La búsqueda no modifica WhatsApp.

La UI habilita un botón explícito:

`Agregar N contactos a “<lista>”`

La capa MAIN-world utiliza únicamente una acción `add` para la etiqueta destino:

- no reemplaza el conjunto completo de etiquetas;
- no genera acciones `remove` para otras etiquetas.

Después de ejecutar el `add`, el runtime vuelve a consultar `labelItemCollection` hasta confirmar la presencia del chat.

Estados de asignación:

- `PENDING`;
- `ADDING`;
- `ADDED`;
- `ALREADY_IN_LIST`;
- `FAILED`.

`ADDED` significa asignación comprobada, no sólo comando ejecutado.

## Reintentos

Los errores transitorios `LIST_ASSIGNMENT_FAILED` y `LIST_ASSIGNMENT_NOT_CONFIRMED` tienen un máximo de 2 intentos totales por contacto.

No existen loops infinitos.

Un contacto confirmado no vuelve a ejecutarse.

## Pausa, reanudación y cancelación

El estado vive en `chrome.storage.session` bajo un store aislado del CampaignEngine y del Contact Export anterior.

Al pausar:

- el contacto que ya está en una operación de verificación puede terminar;
- antes del siguiente contacto se guarda `paused`;
- los `ADDED`/`ALREADY_IN_LIST` quedan confirmados.

Al reanudar:

- se recorre únicamente `PENDING`;
- no se repiten los confirmados.

Cancelar impide iniciar nuevas asignaciones y conserva el checkpoint visible para diagnóstico.

## Integración con el Paso 2

Después de finalizar el agregado se vuelve a leer el total de la lista.

El nuevo contador también se sincroniza con `ContactExportStore.labels[].countHint` usando la estrategia:

`main-world-refresh-after-message-assignment`

Esto evita que el extractor anterior interprete el total actualizado como un `LABEL_CONTACT_COUNT_MISMATCH`.

Luego el usuario puede continuar con **Analizar contactos** y **Exportar Excel** sin un flujo alternativo.

## Privacidad

La vista previa conserva únicamente:

- nombre disponible;
- teléfono disponible;
- el mensaje coincidente limitado a 500 caracteres;
- estado de membresía/asignación.

No se cargan conversaciones completas.

El diagnóstico no incluye:

- nombres de contactos;
- teléfonos;
- mensajes coincidentes;
- historial de conversaciones.

Sí incluye la frase buscada (máximo 200 caracteres) porque forma parte de los datos necesarios para reproducir el fallo solicitado por el flujo de diagnóstico.

## Diagnóstico 0.9.6

Códigos previstos:

- `GLOBAL_SEARCH_NOT_AVAILABLE`
- `SEARCH_RESULTS_NOT_FOUND`
- `SEARCH_RESULT_PARSE_FAILED`
- `MESSAGE_DIRECTION_UNKNOWN`
- `MESSAGE_DOES_NOT_MATCH`
- `CONTACT_ID_UNRESOLVED`
- `DUPLICATE_CONTACT`
- `LIST_MEMBERSHIP_CHECK_FAILED`
- `LIST_ASSIGNMENT_FAILED`
- `LIST_ASSIGNMENT_NOT_CONFIRMED`
- `SEARCH_VIRTUAL_LIST_STALLED`
- `WHATSAPP_STRUCTURE_CHANGED`

Semáforo:

- VERDE: estructura necesaria disponible / proceso completado sin fallos críticos;
- ROJO: búsqueda estructurada, membresía o asignación crítica rota.

No existe estado amarillo.

## Métricas

La búsqueda registra:

- duración;
- páginas globales consultadas;
- mensajes inspeccionados;
- mensajes que cumplen texto;
- direcciones desconocidas;
- no-contactos excluidos;
- chats abiertos;
- operaciones visuales.

En la estrategia primaria, `chatsOpened = 0` y `visualOperations = 0`.

## Testing automatizado

Archivos principales:

- `tests/add-contacts-by-message.test.ts`
- `tests/add-contacts-by-message-main-world.test.ts`
- `tests/add-contacts-by-message-ui.test.ts`

Cubren contains/exact, received-only, dirección desconocida, deduplicación, teléfono, membresía, exclusiones, checkpoint, progreso, estructura MAIN-world, asignación y verificación de membresía, además del contrato visual del Paso 1.5.

La suite general del repositorio continúa siendo la barrera de regresión para sender, imágenes, textos, pausa/reanudación, diagnóstico, popup, service worker y Contact Export.

## Limitación de validación automática

Los mocks verifican el contrato con las colecciones estructuradas de WhatsApp y la lógica de la extensión. Una cuenta real de WhatsApp Business puede cambiar internamente sin aviso; por eso la aceptación final requiere la prueba manual documentada en las release notes de 0.9.6.
