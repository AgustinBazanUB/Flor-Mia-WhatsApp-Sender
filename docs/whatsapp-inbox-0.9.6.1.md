# WhatsApp Inbox — extensión 0.9.6.1

Base de trabajo: `feat/add-contacts-by-message-096`.

Rama de implementación: `feature/whatsapp-inbox-crm-096`.

## Principios

**WhatsApp Web es la fuente principal de los mensajes.**

**Firestore no replica el historial completo de WhatsApp.**

La extensión no persiste conversaciones ni crea una base de mensajes. Su responsabilidad es exponer un contrato pequeño y seguro entre la Web App de Flor Mía y la interfaz real de WhatsApp Web.

## Compatibilidad preservada

Esta implementación se montó sobre la rama 0.9.6, no sobre el `main` 0.9.4.7, porque 0.9.6 contiene el trabajo más reciente de:

- exportación de contactos por etiquetas/listas;
- agregado de contactos por mensaje;
- `contact-export-bootstrap`;
- `message-contact-bootstrap`;
- soporte dinámico de Deploy Previews autorizados.

El Inbox no reemplaza:

- `service-worker.ts`;
- `CampaignRuntime`;
- `whatsapp.ts`;
- el bridge de campañas;
- el adapter de exportación de contactos;
- los flujos de etiquetas existentes.

## Arquitectura

```text
Flor Mía Web App
    ↓ window.postMessage
content/inbox-web-app-bridge.ts
    ↓ canal interno cerrado
background/inbox-service-worker.ts
    ↓ chrome.tabs.sendMessage
content/inbox-runtime.ts
    ↓
src/whatsapp/inbox-adapter.ts
    ↓
WhatsApp Web
```

El flujo de campañas/contact-export sigue utilizando sus contratos existentes y no pasa por estos handlers.

## Canal externo dedicado

Canal:

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

Este canal no comparte el dispatcher de campañas. Un payload de Inbox no puede convertirse en `CAMPAIGN_START`, `WA_SEND_IMAGE`, exportación de contactos ni otro comando existente.

## Canal interno

`src/shared/inbox-protocol.ts` declara el canal:

`flor_mia_whatsapp_inbox_internal`

Sólo acepta:

- `INBOX_GET_CHATS`;
- `INBOX_GET_MESSAGES`;
- `INBOX_SEND_TEXT`.

Fuentes internas admitidas:

- `web-app-inbox-bridge`;
- `inbox-service-worker`.

Validaciones:

- `requestId` obligatorio y limitado;
- lista máxima 100;
- historial máximo 100;
- `chatId` obligatorio y limitado;
- texto obligatorio y máximo 4.096 caracteres;
- tipos de comandos cerrados.

## Orígenes autorizados

`content/inbox-web-app-bridge.ts` reutiliza `isAllowedWebAppOrigin` de `src/config/origins.ts`.

La rama 0.9.6 acepta:

- producción Flor Mía exacta;
- localhost configurado;
- Deploy Previews cuyo hostname cumpla estrictamente `deploy-preview-N--<sitio-autorizado>.netlify.app`.

No se acepta cualquier sitio externo simplemente por estar en Netlify.

El service worker vuelve a validar `sender.url` antes de reenviar un comando hacia WhatsApp.

## Reinjection guards

Manifest V3 puede invalidar y reinjectar content scripts después de actualizar una extensión unpacked.

Para evitar listeners duplicados, especialmente doble `SEND_TEXT`, se agregaron guards independientes:

- `__florMiaWhatsAppInboxBridgeV1` en la Web App;
- `__florMiaWhatsAppInboxRuntimeV1` en WhatsApp Web.

Una instalación nueva retira el listener anterior antes de registrar el siguiente.

## WhatsApp Adapter

Archivo:

`src/whatsapp/inbox-adapter.ts`

Es la única capa nueva que conoce la estructura del DOM de WhatsApp para Inbox.

Responsabilidades:

- detectar filas de chat;
- extraer nombre, teléfono si está visible, preview y timestamp;
- detectar indicador/contador de no leídos;
- abrir el chat seleccionado;
- obtener mensajes de texto visibles;
- diferenciar salientes/entrantes;
- enviar texto usando el composer real;
- observar evidencia visual del mensaje saliente.

La Web App nunca recibe selectores CSS ni detalles de `data-testid`.

## Reutilización de selectores existentes

El adapter reutiliza:

- `findMainInterface`;
- `findQrCode`;
- `findConversationHeader`;
- `findComposer`;
- `findSendButton`;
- `canonicalMessageText`;
- `outgoingMessages`;
- `prepareComposerTextForSend`;
- `waitForCondition`.

No se creó un segundo composer ni un segundo algoritmo de verificación de texto.

## Lista de chats

`getInboxChats(limit)`:

- verifica que exista sesión/interfaz;
- obtiene únicamente chats visibles/cargados;
- limita la respuesta a 100;
- devuelve un identificador opaco de chat, nombre, teléfono cuando puede probarse, preview, timestamp y no leídos;
- no abre cada conversación;
- no persiste nada.

Los identificadores prefieren atributos estructurados de WhatsApp cuando están disponibles. Si no existen, se utiliza un fingerprint opaco de la fila visible. Ese fallback puede cambiar si WhatsApp re-renderiza radicalmente una fila; por eso un `CHAT_NOT_FOUND` se trata como error recuperable, no como identidad permanente.

## Teléfono

El adapter sólo devuelve teléfono cuando encuentra una cadena plausible de 8–15 dígitos en nombre/metadatos visibles de la fila o encabezado.

No inventa un número a partir de un nombre guardado.

La normalización comercial definitiva ocurre en la Web App utilizando `normalizeCustomerPhone` del CRM.

## Mensajes recientes

`getInboxMessages(chatId, limit)`:

1. encuentra la fila correspondiente;
2. abre el chat;
3. espera el encabezado real;
4. inspecciona sólo el DOM del chat abierto;
5. devuelve únicamente texto;
6. recorta al bloque más reciente;
7. informa `hasMore` cuando había más nodos cargados.

No hace scroll automático hacia meses de historial ni descarga toda la conversación.

## No leídos

El contador se obtiene de indicadores semánticos/datos visibles de la fila de WhatsApp.

No se sintetiza un estado alternativo.

Cuando el Inbox abre una conversación, WhatsApp puede marcarla como leída de acuerdo con su comportamiento normal. La respuesta de conversación devuelve `unreadCount: 0` para ese chat abierto.

## Envío de texto

`sendInboxText(chatId, message)`:

- valida ID y longitud;
- abre el chat seleccionado;
- encuentra el composer real;
- reutiliza `prepareComposerTextForSend`, que evita sobrescribir drafts conflictivos;
- encuentra el botón de envío mediante los selectores existentes;
- toma un baseline de mensajes salientes con el texto exacto;
- hace click;
- espera una nueva evidencia saliente.

Devuelve:

```ts
{
  chatId,
  sent: true,
  verified: boolean,
  sentAt
}
```

Si no aparece evidencia fuerte pero el composer quedó consumido, `verified` puede ser `false`. La extensión no afirma una confirmación que WhatsApp no expuso.

Si el composer conserva texto después del intento, se devuelve error de verificación.

## Etiquetas

0.9.6 posee un adapter completo para etiquetas/listas en:

`src/contact-export/whatsapp-contact-adapter.ts`.

Ese adapter detecta etiquetas abriendo el hub comercial y, para relacionar contactos, recorre listas etiquetadas. Esa estrategia es adecuada para una tarea explícita de exportación, pero no para hidratar cada fila del Inbox porque:

- cambia visualmente la UI de WhatsApp;
- puede requerir scroll/hidratación;
- consume tiempo por etiqueta;
- puede competir con la atención de chats;
- puede interferir con una exportación ya en curso.

Por eso `WhatsAppInboxChat.labels` existe como contrato preparado pero se devuelve vacío cuando no hay una evidencia barata y directa por fila. No se introduce un segundo sistema de etiquetas.

## Contact export / add contacts

El Inbox se agregó sin tocar los dispatchers de:

- `WA_CONTACT_EXPORT_DETECT_LABELS`;
- `WA_CONTACT_EXPORT_ANALYZE`;
- `WA_CONTACT_EXPORT_CANCEL`;
- flujos de agregado de contactos por mensaje.

`recovery-bootstrap.ts` conserva:

```ts
import "./contact-export-bootstrap";
import "./message-contact-bootstrap";
```

y agrega el worker de Inbox como una responsabilidad separada.

## Campañas masivas

No se modificó `CampaignRuntime` ni el service worker principal para enrutar acciones de Inbox.

El envío del Inbox no usa:

- cola de campaña;
- pacing diario;
- retry de campaña;
- imágenes de campaña;
- estado persistido de campaña.

Esto evita que una respuesta manual aparezca como un destinatario de campaña.

Limitación operativa de esta primera etapa: no se recomienda ejecutar una exportación visual de etiquetas o una campaña que esté manipulando activamente WhatsApp Web al mismo tiempo que se atienden chats desde Inbox. La segunda etapa de QA debe validar y, si corresponde, formalizar un lock/arbiter compartido para operaciones visuales concurrentes.

## Manifest y build

Versión de rama: `0.9.6.1`.

`manifest.json` agrega:

- `content/inbox-runtime.js` en WhatsApp Web;
- `content/inbox-web-app-bridge.js` en Web App.

`scripts/build.mjs` agrega ambos bundles y conserva:

- popup;
- contact export page;
- diagnostics;
- bridge existente;
- configuración dinámica de orígenes/Deploy Preview.

## Firestore

La extensión no accede a Firestore para el Inbox.

No existe almacenamiento de mensajes en:

- `chrome.storage`;
- Firebase;
- archivos locales.

El payload sólo vive durante la operación Web App ↔ extensión.

## Logs y privacidad

Los nuevos handlers no registran contenido del chat ni cuerpo de mensajes.

Los errores transportados contienen:

- código;
- mensaje técnico/operativo;
- `recoverable`;
- detalles acotados.

No se añade `console.log` con conversaciones completas.

## Errores relevantes

Se reutilizan códigos existentes cuando corresponde:

- `WHATSAPP_NOT_OPEN`;
- `SESSION_NOT_READY`;
- `INTERFACE_LOADING`;
- `INVALID_INPUT`;
- `CONTACT_UNAVAILABLE`;
- `ELEMENT_NOT_FOUND`;
- `TIMEOUT`;
- `VERIFICATION_FAILED`;
- `INTERNAL_ERROR`.

Los detalles `inboxReason` permiten diferenciar casos como `CHAT_NOT_FOUND`, `MESSAGES_NOT_AVAILABLE` o `SEND_FAILED` sin agregar mensajes privados a logs.

## Archivos agregados

- `src/whatsapp/inbox-adapter.ts`;
- `src/shared/inbox-protocol.ts`;
- `src/background/inbox-service-worker.ts`;
- `src/content/inbox-runtime.ts`;
- `src/content/inbox-web-app-bridge.ts`;
- `tests/inbox-protocol.test.ts`;
- `docs/whatsapp-inbox-0.9.6.1.md`.

## Archivos modificados

- `manifest.json`;
- `scripts/build.mjs`;
- `src/background/recovery-bootstrap.ts`.

No se modificó el service worker principal de campañas ni `src/content/whatsapp.ts` en la rama final basada en 0.9.6.

## Limitaciones

1. El DOM de WhatsApp puede cambiar.
2. El teléfono no siempre está expuesto para contactos guardados.
3. El chat ID fallback no debe tratarse como ID permanente fuera de la sesión DOM actual.
4. Sólo se muestran mensajes de texto cargados en el DOM.
5. No hay multimedia en Inbox.
6. No se gestiona todavía la asignación de etiquetas por chat.
7. Falta QA manual cruzado con campaña/contact-export en escenarios concurrentes.
8. Falta test en WhatsApp Web real con múltiples idiomas/variantes de interfaz.

## Próxima etapa de QA

Ejecutar checklist exhaustiva sobre:

- cambios de selectores;
- chats archivados/fijados/grupos/canales;
- contactos guardados vs números sin guardar;
- no leídos 1, 9, 99+;
- chat que desaparece/reordena entre lista y click;
- drafts existentes;
- dos mensajes iguales consecutivos;
- reinyección MV3;
- refresh de WhatsApp durante una acción;
- exportación de contactos activa + Inbox;
- campaña activa + Inbox;
- permisos/orígenes de Deploy Preview;
- memoria y performance con listas grandes.
