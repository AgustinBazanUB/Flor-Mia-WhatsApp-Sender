# WhatsApp Inbox — arquitectura de extensión

Base funcional: `feat/add-contacts-by-message-096` (workspace/version 0.9.6).

Rama de implementación: `feature/whatsapp-inbox-crm-096`.

## Principios

**WhatsApp Web es la fuente principal de los mensajes.**

**Firestore no replica el historial completo de WhatsApp.**

La extensión no persiste conversaciones. Expone únicamente un puente acotado para consultar chats/mensajes de texto visibles y enviar una respuesta de texto desde la Web App.

## Por qué la rama parte de 0.9.6

`main` de la extensión continúa en 0.9.4.7, pero la rama `feat/add-contacts-by-message-096` contiene el trabajo más reciente de:

- exportación de contactos por etiquetas/listas;
- extracción phone-first;
- agregado de contactos por frase/mensaje;
- `contact-export-bootstrap`;
- `message-contact-bootstrap`;
- Deploy Previews dinámicos autorizados.

El Inbox se agregó encima de esa rama para no perder ni sobrescribir esas funciones.

## Arquitectura

```text
Flor Mía Web App
    ↓ window.postMessage
content/inbox-web-app-bridge.ts
    ↓ chrome.runtime.sendMessage
background/inbox-service-worker.ts
    ↓ chrome.tabs.sendMessage
content/inbox-runtime.ts
    ↓
whatsapp/inbox-adapter.ts
    ↓
WhatsApp Web
```

Campañas y Contact Export mantienen su propio protocolo y sus dispatchers actuales.

## Contrato Web App ↔ extensión

Canal dedicado:

`flor_mia_whatsapp_inbox_extension`

Versión: `1`.

Solicitudes permitidas:

- `FLORMIA_INBOX_GET_CHATS_REQUEST`;
- `FLORMIA_INBOX_GET_MESSAGES_REQUEST`;
- `FLORMIA_INBOX_SEND_TEXT_REQUEST`.

Respuestas:

- `FLORMIA_INBOX_CHATS`;
- `FLORMIA_INBOX_MESSAGES`;
- `FLORMIA_INBOX_TEXT_SENT`;
- `FLORMIA_INBOX_ERROR`.

No se agregaron comandos Inbox al protocolo existente de campañas/contact-export. Esto impide que una respuesta manual entre accidentalmente al runtime de campañas.

## Contrato interno

`src/shared/inbox-protocol.ts` usa el canal interno:

`flor_mia_whatsapp_inbox_internal`

Sólo permite:

- `INBOX_GET_CHATS`;
- `INBOX_GET_MESSAGES`;
- `INBOX_SEND_TEXT`.

Validaciones principales:

- source conocida;
- `requestId` obligatorio;
- `chatId` acotado;
- máximo 100 chats/mensajes;
- texto obligatorio;
- máximo 4.096 caracteres;
- ningún comando arbitrario.

## Seguridad de origen

`inbox-web-app-bridge.ts` reutiliza `isAllowedWebAppOrigin`.

La configuración 0.9.6 permite:

- dominios productivos exactos de Flor Mía;
- localhost configurado;
- Deploy Previews que cumplan `deploy-preview-N--<sitio-autorizado>.netlify.app` para los nombres de sitio aprobados.

El service worker vuelve a validar `sender.url` antes de reenviar una acción a WhatsApp.

No se usa `externally_connectable`, `eval` ni HTML inyectado.

## Reinjection guards

Para evitar listeners duplicados después de recargar/actualizar una extensión MV3:

- `__florMiaWhatsAppInboxBridgeV1` protege el bridge de Web App;
- `__florMiaWhatsAppInboxRuntimeV1` protege el runtime de WhatsApp.

Antes de registrar un listener nuevo se retira el anterior. Este guard es especialmente importante para impedir doble `SEND_TEXT`.

## WhatsApp Adapter

`src/whatsapp/inbox-adapter.ts` encapsula toda la dependencia nueva del DOM de WhatsApp.

Responsabilidades:

- listar chats visibles;
- leer nombre/teléfono cuando WhatsApp lo expone;
- leer preview/hora/no leídos;
- abrir un chat;
- devolver texto reciente cargado en el DOM;
- distinguir mensajes entrantes/salientes;
- enviar texto;
- verificar evidencia visual del mensaje saliente.

La Web App nunca conoce selectores de WhatsApp.

El adapter reutiliza funciones ya existentes de la extensión:

- `findMainInterface`;
- `findQrCode`;
- `findConversationHeader`;
- `findComposer`;
- `findSendButton`;
- `canonicalMessageText`;
- `outgoingMessages`;
- `prepareComposerTextForSend`;
- `waitForCondition`.

## Lectura eficiente

`getInboxChats` devuelve por defecto hasta 80 chats y nunca más de 100.

`getInboxMessages` devuelve por defecto hasta 50 mensajes de texto visibles y nunca más de 100. Si el DOM tenía más nodos de texto, responde `hasMore: true` para una futura estrategia incremental.

No hay scroll automático de meses de historial, polling ni persistencia de mensajes.

## Teléfono

El adapter sólo devuelve un teléfono si encuentra una cadena plausible de 8–15 dígitos en información visible de fila/encabezado.

No adivina el teléfono de un contacto guardado a partir del nombre.

La normalización CRM definitiva ocurre en la Web App mediante `normalizeCustomerPhone`.

## No leídos

Se utilizan indicadores semánticos visibles de WhatsApp (`aria-label`, `data-testid` y equivalentes). Si WhatsApp no expone el estado, no se fabrica otro.

Abrir una conversación sigue el comportamiento normal de WhatsApp y puede marcarla como leída.

## Envío de texto

`sendInboxText`:

1. valida `chatId` y texto;
2. abre la conversación seleccionada;
3. encuentra el composer real;
4. reutiliza la preparación de texto existente, que evita pisar drafts conflictivos;
5. busca el botón de envío mediante selectores centralizados;
6. toma un baseline de mensajes salientes iguales;
7. hace click;
8. espera una nueva evidencia saliente.

Respuesta:

```ts
{ chatId, sent: true, verified: boolean, sentAt }
```

Si el composer fue consumido pero WhatsApp no expone evidencia fuerte, `verified` puede ser `false`. No se simula una confirmación inexistente.

## Etiquetas

0.9.6 ya posee el sistema real de etiquetas/listas en `src/contact-export/whatsapp-contact-adapter.ts`.

Ese flujo abre el hub de Etiquetas y recorre listas para resolver contactos. Reutilizarlo en cada chat del Inbox sería costoso, modificaría visualmente WhatsApp y podría interferir con Contact Export.

Por eso el contrato de Inbox deja `labels: string[]` preparado, pero no recorre el hub por cada chat ni crea un segundo sistema de etiquetas. La gestión por contacto queda pendiente hasta contar con una estrategia estable y compartida.

## Compatibilidad con Contact Export y Add Contacts By Message

La rama final conserva sin reemplazar:

```ts
import "./contact-export-bootstrap";
import "./message-contact-bootstrap";
```

El Inbox añade `inbox-service-worker` como responsabilidad separada.

No se modificó `src/content/whatsapp.ts` en esta rama final ni se reemplazaron los handlers de exportación.

## Compatibilidad con campañas

No se modifica `CampaignRuntime` ni se enrutan acciones del Inbox por el service worker principal de campañas.

Una respuesta manual no consume:

- pacing de campañas;
- contador de destinatarios;
- retry de campaña;
- imágenes de campaña;
- estado persistido de campaña.

La segunda etapa de QA debe probar operaciones visuales concurrentes (campaña/exportación activa mientras se intenta atender un chat). En esta primera etapa no se recomienda manipular simultáneamente WhatsApp desde dos flujos visuales.

## Manifest y build

El workspace conserva versión `0.9.6` para mantener coherencia con `package.json`, `package-lock.json` y el validador de release de Contact Export.

`manifest.json` agrega:

- `content/inbox-runtime.js` en WhatsApp Web;
- `content/inbox-web-app-bridge.js` en la Web App.

`scripts/build.mjs` genera ambos bundles y conserva popup, Contact Export, diagnostics y bridge existente.

## Firestore y almacenamiento

El Inbox de la extensión no accede a Firestore.

No guarda mensajes en `chrome.storage`, IndexedDB ni archivos. El contenido sólo existe en memoria durante la operación del bridge.

## Logs y privacidad

Los handlers nuevos no registran cuerpos completos de conversaciones. Los errores transportan código, mensaje operativo, `recoverable` y detalles acotados.

## Archivos nuevos

- `src/whatsapp/inbox-adapter.ts`;
- `src/shared/inbox-protocol.ts`;
- `src/background/inbox-service-worker.ts`;
- `src/content/inbox-runtime.ts`;
- `src/content/inbox-web-app-bridge.ts`;
- `tests/inbox-protocol.test.ts`;
- `docs/whatsapp-inbox.md`.

## Archivos modificados

- `manifest.json`;
- `scripts/build.mjs`;
- `src/background/recovery-bootstrap.ts`.

## Limitaciones

1. WhatsApp puede cambiar el DOM.
2. El teléfono puede no estar visible para un contacto guardado.
3. El fallback de `chatId` es opaco pero no debe tratarse como identidad permanente fuera del DOM actual.
4. Sólo se leen mensajes de texto cargados en el DOM.
5. No hay multimedia.
6. Etiquetas por chat todavía no se administran desde Inbox.
7. Falta QA manual cruzado con campañas/contact-export concurrentes.
8. Falta prueba en WhatsApp Web real con distintos idiomas y variantes de UI.

## Troubleshooting

- `WHATSAPP_NOT_OPEN`: abrir `web.whatsapp.com` en la misma sesión de Chrome.
- `SESSION_NOT_READY`: completar QR/inicio de sesión.
- `INTERFACE_LOADING`: recargar WhatsApp si todavía no cargó la interfaz principal.
- `CONTACT_UNAVAILABLE`: el chat cambió/reordenó y debe refrescarse la lista.
- `ELEMENT_NOT_FOUND`: WhatsApp cambió o todavía no montó composer/botón.
- `VERIFICATION_FAILED`: el intento no produjo evidencia suficiente de envío.

## Próxima etapa de QA

Validar exhaustivamente:

- contactos guardados/no guardados;
- grupos/canales/archivados;
- no leídos 1/9/99+;
- dos mensajes iguales consecutivos;
- draft preexistente;
- reordenamiento de lista entre click y envío;
- reinyección MV3;
- reload de WhatsApp durante operación;
- campaña activa + Inbox;
- Contact Export activo + Inbox;
- Deploy Preview y orígenes;
- cambios de selectores;
- memoria/performance con listas grandes.
