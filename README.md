# Flor Mía WhatsApp Sender

Extensión privada de Google Chrome, Manifest V3, que recibe órdenes de la Web-App Integral Flor Mía y opera sobre la sesión que el usuario ya abrió manualmente en WhatsApp Web.

Esta primera versión implementa una vertical técnica deliberadamente acotada: diagnóstico de WhatsApp Web y envío manual de **un contacto + un texto**, con confirmación DOM de un nuevo mensaje saliente. No ejecuta campañas masivas ni envía imágenes.

## Requisitos

- Google Chrome 120 o superior.
- Node.js 20 o superior.
- Una sesión de WhatsApp o WhatsApp Business iniciada por el usuario en <https://web.whatsapp.com/>.

La extensión no almacena cookies, QR, contraseñas ni credenciales de WhatsApp.

## Instalar y construir

```bash
npm install
npm run verify
```

El build cargable queda en `dist/`.

Para desarrollo continuo:

```bash
npm run dev
```

## Cargar en Chrome

1. Abrir `chrome://extensions`.
2. Activar **Modo desarrollador**.
3. Elegir **Cargar extensión sin empaquetar**.
4. Seleccionar la carpeta `dist/` de este repositorio.
5. Abrir <https://web.whatsapp.com/> e iniciar la sesión manualmente si aparece el QR.

## Diagnóstico y primera prueba

1. Abrir WhatsApp Web y esperar a ver la lista de chats.
2. Abrir el popup **Flor Mía WhatsApp Sender**.
3. Pulsar **Ejecutar diagnóstico**.
4. Introducir un teléfono en formato internacional explícito, por ejemplo `+549...`. No se asume ningún país.
5. Escribir un texto de prueba y pulsar **Enviar mensaje de prueba**.
6. La extensión informa éxito únicamente si encuentra un mensaje saliente nuevo cuyo texto coincide con la operación.

Si la conversación tiene un borrador, la prueba se detiene para no sobrescribirlo. Si WhatsApp cambia su DOM, el popup mostrará el paso y el error; los logs técnicos están en el Service Worker y en la consola de WhatsApp Web, sin el texto privado ni el teléfono completo.

## Orígenes de Flor Mía

Los orígenes autorizados se centralizan en [`config/allowed-origins.json`](config/allowed-origins.json):

- producción: `https://app-integral-fm.netlify.app/*`;
- desarrollo: `http://localhost:5173/*`.

Para agregar temporalmente un Deploy Preview explícito durante el build:

```bash
FLORMIA_EXTRA_WEB_APP_ORIGINS=https://deploy-preview.example.netlify.app/* npm run build
```

En PowerShell:

```powershell
$env:FLORMIA_EXTRA_WEB_APP_ORIGINS='https://deploy-preview.example.netlify.app/*'
npm.cmd run build
```

No se utiliza `<all_urls>`.

## Comandos de verificación

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run validate:build
```

## Límites actuales

- La sesión y el QR siempre se manejan manualmente en WhatsApp Web.
- Los selectores usan roles, atributos semánticos y fallbacks centralizados, pero un cambio profundo del DOM de WhatsApp puede exigir una actualización.
- La verificación confirma un nuevo mensaje saliente correspondiente al texto. No afirma lectura ni entrega al teléfono.
- El puente de campaña valida y guarda localmente hasta tres imágenes, pero todavía no ejecuta campañas.
- No hay envíos masivos, tandas, límites diarios, reintentos completos ni técnicas anti-detección.

## Reservado para el Prompt 2

La arquitectura ya separa coordinación, DOM, protocolo, estado y blobs para incorporar después:

- envío real de imágenes;
- operación atómica Imagen 1 → Imagen 2 → Imagen 3 → Texto;
- checkpoints por destinatario;
- reintentos controlados y recuperación tras reinicio del Service Worker.

Consultar también [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) y [`docs/MANUAL-TEST.md`](docs/MANUAL-TEST.md).
