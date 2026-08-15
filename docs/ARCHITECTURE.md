# Arquitectura

## Componentes

- `src/popup/`: interfaz técnica. Solo consulta estado, dispara diagnóstico y solicita una prueba manual.
- `src/background/service-worker.ts`: coordinador central. Valida remitentes, mantiene estado, dirige pasos y registra resultados.
- `src/content/whatsapp.ts`: adaptador de alto nivel para WhatsApp Web.
- `src/content/web-app-bridge.ts`: frontera segura `window.postMessage` ↔ runtime de Chrome, restringida a orígenes autorizados.
- `src/whatsapp/`: selectores, esperas con `MutationObserver`, preflight, escritura, envío y verificación.
- `src/shared/`: protocolo, contrato de campaña, estado, errores, teléfonos y logging.
- `src/storage/`: `chrome.storage.local` para estado JSON e IndexedDB para `Blob` temporales.

## Flujo de prueba

1. Popup envía `SEND_TEST_TEXT` con una acción explícita del usuario.
2. Service Worker valida teléfono internacional y texto.
3. Ejecuta preflight contra el Content Script de WhatsApp.
4. Ordena abrir `https://web.whatsapp.com/send?phone=…` en la misma pestaña.
5. Espera la reinyección del Content Script y la conversación.
6. Content Script localiza el composer por estrategias centralizadas, rechaza sobrescribir borradores y escribe el texto por DOM.
7. Localiza y activa el botón semántico de envío.
8. Compara el snapshot anterior con los mensajes salientes posteriores.
9. Solo confirma cuando aparece un elemento saliente nuevo con texto coincidente.
10. Service Worker persiste checkpoint, resultado y error estructurado si corresponde.

## Contrato Web-App

Canal `flor_mia_whatsapp_extension`, versión `1`. El puente implementa `PING`, `CAMPAIGN_PREPARE` y `CAMPAIGN_CANCEL_REQUEST`, con `replyTo`, validación de origen y schemas. Los binarios entran por `ArrayBuffer`, se serializan únicamente para cruzar el runtime de Chrome y quedan como `Blob` en IndexedDB de la extensión. No se persisten en Firebase.

La campaña se acepta y almacena, pero su ejecución masiva está deliberadamente fuera del Prompt 1.

## Persistencia y tolerancia a terminación

Manifest V3 puede detener el Service Worker. Por eso el estado operativo, la campaña recibida, el progreso, el paso actual, el contacto actual, errores, último checkpoint y resultados se guardan fuera de variables globales. El historial está acotado a 20 operaciones y 20 errores.

## Seguridad

- Sin cookies, credenciales, QR ni tokens.
- Sin automatización del sistema operativo, coordenadas, Selenium o Playwright en el producto.
- Sin `<all_urls>`.
- Validación de `sender.id`, URL del remitente, origen de página, canal, versión, tipo y payload.
- Teléfonos enmascarados y textos redactados en logs.
- No inicia envíos automáticamente.
