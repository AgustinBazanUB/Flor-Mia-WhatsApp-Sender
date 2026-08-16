# Privacidad y seguridad

## Datos procesados

Flor Mía entrega destinatarios explícitos, texto y hasta tres imágenes. La extensión no genera ni scrapea números. El teléfono normalizado y el texto se conservan localmente solo mientras son necesarios para ejecutar/reanudar la campaña. Los blobs compartidos viven en IndexedDB y no se duplican por destinatario.

## Datos que salen hacia Flor Mía

El bridge publica estado operacional, progreso agregado, ID interno del destinatario actual, teléfono enmascarado, checkpoint/step, tanda, límite agregado y errores controlados. El nombre del destinatario está deshabilitado por defecto. Nunca publica el texto, el teléfono completo, `countedContactKeys`, lista completa, binarios/base64, conversaciones, HTML, cookies, credenciales, tokens o QR.

## Retención

- `completed` y `stopped`: primero se valida/persiste el resultado e historial mínimo; después se eliminan los blobs temporales de la campaña.
- `paused`, `images_required` y `error`: campaña, checkpoint y blobs se conservan para una recuperación segura.
- historial: máximo 50 resúmenes, sin destinatarios ni contenido de mensajes;
- evento público: solo el último snapshot/evento y metadata monotónica;
- trazas: buffers acotados según `DIAGNOSTICS.md`.

## Controles de frontera

- orígenes exactos y declarados, sin `<all_urls>`;
- `sender.id` y URL del Content Script validados en el Service Worker;
- envelope/payload validado en runtime;
- `campaignId` activo verificado para controles;
- inyección de fallos disponible solo por mensajes internos del popup/desarrollo y rechazada desde la Web-App;
- permisos mínimos: `storage`, `alarms` y host de WhatsApp Web.

## Exclusiones deliberadas

No hay técnicas anti-detección, ocultamiento de automatización, control de mouse/teclado físico, coordenadas, almacenamiento de sesión de WhatsApp ni transmisión automática de reportes. El usuario inicia sesión y autoriza campañas/contactos por fuera de la extensión.
