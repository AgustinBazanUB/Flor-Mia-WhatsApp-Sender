# Flor Mía WhatsApp Sender

Extensión privada de Google Chrome, Manifest V3, que opera sobre la sesión que el usuario inició manualmente en WhatsApp Web. La versión `0.2.0` implementa el motor atómico de **un contacto**: abre la conversación, envía de cero a tres imágenes individualmente y, si existe, envía el texto al final.

Cada paso se considera completo solo cuando existe evidencia nueva en el DOM de WhatsApp. Un paso no confirmado bloquea todos los posteriores.

## Alcance de esta versión

- solo texto;
- una, dos o tres imágenes en orden y texto opcional al final;
- checkpoint persistente antes y después de cada intento;
- máximo configurable de tres intentos por paso, con backoff;
- pausa automática ante agotamiento, archivo faltante o resultado ambiguo;
- reanudación sin repetir pasos confirmados;
- reconciliación del DOM antes de decidir si un envío ambiguo debe repetirse;
- recuperación del estado cuando Manifest V3 reinicia el Service Worker;
- inyección explícita de fallos desde el popup, aislada del puente de la Web-App.

Todavía no ejecuta listas completas de destinatarios, tandas, límites diarios ni automatizaciones masivas. El puente acepta y guarda una campaña de la Web-App, pero la ejecución multi-contacto queda reservada al Prompt 3.

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

El build cargable queda en `dist/`. Para desarrollo continuo:

```bash
npm run dev
```

## Cargar en Chrome

1. Abrir `chrome://extensions`.
2. Activar **Modo desarrollador**.
3. Elegir **Cargar extensión sin empaquetar**.
4. Seleccionar la carpeta `dist/` de este repositorio.
5. Después de cada build, pulsar **Recargar** en la tarjeta de la extensión.
6. Abrir <https://web.whatsapp.com/> y completar manualmente el QR si corresponde.

## Probar un contacto

1. Abrir WhatsApp Web y esperar a ver la lista de chats.
2. Abrir el popup **Flor Mía WhatsApp Sender**.
3. Pulsar **Ejecutar diagnóstico**.
4. Introducir un teléfono propio/de prueba en formato internacional explícito, por ejemplo `+549...`.
5. Escribir texto, seleccionar hasta tres imágenes en el orden deseado, o ambas cosas.
6. Pulsar una sola vez **Procesar contacto de prueba**.
7. Revisar en el popup el estado, el número de intentos y el checkpoint de cada paso.

El flujo es `Imagen 1 → Imagen 2 → Imagen 3 → Texto`, omitiendo los pasos que no existan. Si una conversación tiene un borrador, el texto se detiene para no sobrescribirlo.

## Recuperación segura

- **Error antes de enviar:** el mismo paso se reintenta; nunca avanza al siguiente.
- **Tres fallos recuperables:** el contacto queda pausado y requiere reanudación manual.
- **Clic realizado sin confirmación:** queda en `verification_pending`. Al reanudar se inspecciona el DOM; no se vuelve a enviar mientras el resultado siga ambiguo.
- **Imagen temporal ausente:** el popup solicita el archivo faltante. Debe coincidir en nombre, tipo y tamaño con el original.
- **Service Worker terminado:** el checkpoint se rehidrata desde `chrome.storage.local`. Un paso que estaba en curso pasa a verificación pendiente para evitar duplicados.

## Inyección de fallos

El selector **Inyección de fallos (solo desarrollo)** permite simular timeout, mecanismo de adjuntos, preview, fallo único, tres fallos, verificación ambigua o una imagen faltante. Solo se aplica al proceso iniciado manualmente desde el popup. Nunca se activa en campañas recibidas desde la Web-App.

## Orígenes de Flor Mía

Los orígenes autorizados se centralizan en [`config/allowed-origins.json`](config/allowed-origins.json):

- producción: `https://app-integral-fm.netlify.app/*`;
- desarrollo: `http://localhost:5173/*`.

No se utiliza `<all_urls>`.

## Verificación

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run validate:build
```

Consultar también [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) y [`docs/MANUAL-TEST.md`](docs/MANUAL-TEST.md).

## Limitaciones actuales

- La sesión y el QR siempre se manejan manualmente.
- La confirmación prueba que apareció un mensaje saliente nuevo; no afirma entrega ni lectura en el teléfono.
- WhatsApp Web no ofrece una API pública de DOM estable. Un cambio profundo de su interfaz puede exigir actualizar selectores.
- No hay envío masivo, tandas, límites diarios ni técnicas anti-detección.
- La prueba real con una sesión iniciada debe realizarse manualmente después de cargar el build; los tests automatizados usan DOM controlado y no envían mensajes reales.
