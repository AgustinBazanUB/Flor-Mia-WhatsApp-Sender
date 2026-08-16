# Arquitectura

## Componentes

- `src/engine/`: modelo de pasos, motor atómico por contacto, checkpoints, política de reintentos, reconciliación e inyección de fallos de desarrollo.
- `src/background/service-worker.ts`: coordinador Manifest V3; crea/reanuda el proceso, sincroniza estado y rehidrata checkpoints.
- `src/background/contact-adapter.ts`: adapta el motor a IndexedDB y al Content Script de WhatsApp.
- `src/content/whatsapp.ts`: frontera de mensajes internos para diagnóstico, navegación, envío y reconciliación.
- `src/content/web-app-bridge.ts`: frontera segura `window.postMessage` ↔ runtime de Chrome, restringida a orígenes autorizados.
- `src/whatsapp/`: selectores, esperas, preflight, envío de texto, envío de imagen y evidencia DOM.
- `src/storage/`: estado/checkpoint JSON en `chrome.storage.local` y `Blob` temporales en IndexedDB.
- `src/popup/`: arnés técnico para un contacto, reanudación, re-selección de archivos y fallos simulados.

## Máquina de pasos por contacto

Los pasos se construyen dinámicamente y conservan un `operationId` estable:

```text
campaignId:contactId:image-1
campaignId:contactId:image-2
campaignId:contactId:image-3
campaignId:contactId:text
```

Para cada contacto se ejecutan únicamente los pasos existentes, ordenados como imágenes individuales y texto al final. Los estados de paso son `pending`, `in_progress`, `verification_pending`, `confirmed`, `failed` e `images_required`.

El motor persiste antes del intento, después del resultado y después de cada reconciliación. `lastConfirmedStepId` es la frontera segura de reanudación. Los pasos `confirmed` nunca se ejecutan otra vez.

## Envío y verificación de imágenes

1. Captura las identidades de mensajes multimedia salientes existentes.
2. Localiza el control de adjuntos mediante estrategias centralizadas.
3. Reconstruye un `File` desde el `Blob` local y verifica nombre, tipo y tamaño en el input.
4. Espera el preview y comprueba nuevamente sus metadatos.
5. Acciona el botón semántico de envío.
6. Confirma únicamente si aparece un mensaje multimedia saliente nuevo y el preview deja de estar visible.

El cierre del preview por sí solo no confirma éxito. Si el clic ocurrió pero falta evidencia concluyente, el resultado es ambiguo.

## Envío y verificación de texto

El motor rechaza sobrescribir borradores, escribe el texto, toma un snapshot de mensajes salientes y confirma únicamente un nodo nuevo con contenido canónicamente coincidente. El texto nunca se ejecuta si una imagen anterior no quedó confirmada.

## Reintentos y atomicidad

La política centralizada configura máximo de intentos, backoff y timeouts para conversación, carga de imagen, preview, composer, confirmación y reconciliación. Los fallos previos al envío pueden reintentarse hasta tres veces. Un fallo no recuperable detiene el contacto inmediatamente.

Cuando se agotan los intentos, el proceso se pausa. Ningún paso posterior puede adelantarse a uno pendiente o fallido.

## Resultados ambiguos

Si se accionó enviar pero la verificación no concluyó, el paso pasa a `verification_pending`. La próxima reanudación ejecuta primero una reconciliación DOM:

- nuevo saliente coincidente: confirma y continúa;
- composer o preview todavía preparado: clasifica `not_sent` y permite un nuevo intento;
- evidencia insuficiente: mantiene la pausa sin duplicar.

## Persistencia y terminación de Manifest V3

El checkpoint guarda campaña, contacto, pasos, intentos, verificaciones, error, paso actual e historial técnico acotado. Al iniciar, el Service Worker lo rehidrata. Cualquier paso encontrado `in_progress` se transforma en `verification_pending`; así una terminación entre clic y confirmación no provoca un reenvío ciego.

Las imágenes permanecen en IndexedDB mientras exista la campaña. Si falta un `Blob`, el paso pasa a `images_required` y el usuario puede re-seleccionar el archivo original sin perder el checkpoint.

## Contrato Web-App

El canal `flor_mia_whatsapp_extension`, versión `1`, valida origen, remitente, tipo y payload. En esta etapa `CAMPAIGN_PREPARE` valida y guarda texto, destinatarios e imágenes, pero no recorre la lista. El motor probado de un contacto es la base reutilizable que el Prompt 3 conectará al scheduler multi-contacto.

## Seguridad y privacidad

- sin cookies, credenciales, QR ni tokens;
- sin coordenadas, Selenium, Playwright o automatización del sistema operativo en el producto;
- sin `<all_urls>`;
- teléfonos enmascarados y textos omitidos de logs técnicos;
- identificadores estables para correlación, sin contenido privado;
- ninguna ejecución automática al cargar una página.
