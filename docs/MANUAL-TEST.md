# Prueba manual con una sesión real

Esta comprobación requiere la sesión real del usuario y no puede sustituirse por tests unitarios.

1. Ejecutar `npm run verify`.
2. Cargar `dist/` en `chrome://extensions` mediante **Cargar extensión sin empaquetar**.
3. Abrir `https://web.whatsapp.com/` y completar manualmente el QR si corresponde.
4. En el popup, ejecutar el diagnóstico. Debe indicar página abierta, sesión iniciada e interfaz disponible.
5. Usar un número propio/de prueba en formato internacional y un texto inequívoco.
6. Pulsar una sola vez **Enviar mensaje de prueba**.
7. Confirmar que WhatsApp abrió el contacto correcto y que apareció el mensaje saliente.
8. Confirmar en el popup `Mensaje saliente verificado` y el método `new-outgoing-message-dom`.

Si falla, inspeccionar:

- `chrome://extensions` → Flor Mía WhatsApp Sender → **Service worker**;
- consola de DevTools de la pestaña de WhatsApp Web;
- último error visible en el popup.

Los logs registran códigos, pasos, longitud y estrategias; no incluyen el mensaje completo ni el teléfono completo.
