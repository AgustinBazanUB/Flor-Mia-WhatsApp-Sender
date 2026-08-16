# Prueba manual con una sesión real

Estas pruebas envían mensajes reales. Usar únicamente un número propio o un destinatario que haya autorizado la prueba.

## Preparación

1. Ejecutar `npm run verify`.
2. Abrir `chrome://extensions` y cargar o recargar la carpeta `dist/`.
3. Abrir `https://web.whatsapp.com/` y completar manualmente el QR si corresponde.
4. Esperar a que aparezca la lista de chats.
5. Abrir el popup y ejecutar el diagnóstico. Página, sesión e interfaz deben estar disponibles.

## Caso A: solo texto

1. Escribir un teléfono internacional propio/de prueba.
2. No seleccionar imágenes.
3. Escribir un texto inequívoco.
4. Pulsar una sola vez **Procesar contacto de prueba**.
5. Confirmar un único paso `Texto · Confirmado` y el mensaje saliente real en WhatsApp.

## Caso B: una imagen y texto

1. Seleccionar una imagen pequeña y escribir texto.
2. Procesar el contacto.
3. Confirmar que primero aparece la imagen y después el texto.
4. Confirmar en el popup que ambos pasos tienen un intento y estado `Confirmado`.

## Caso C: tres imágenes y texto

1. Seleccionar tres imágenes en el orden deseado y escribir texto.
2. Procesar el contacto.
3. Confirmar cuatro mensajes salientes separados en este orden: imagen 1, imagen 2, imagen 3 y texto.
4. Confirmar que el checkpoint final es `text` y el proceso está `completed`.

## Fallo recuperable en imagen 2

1. Elegir tres imágenes y texto.
2. Seleccionar **Imagen 2 falla una vez**.
3. Procesar.
4. Confirmar que imagen 1 tiene un intento, imagen 2 tiene dos y los demás pasos uno. Imagen 1 no debe duplicarse.

## Pausa tras tres fallos

1. Repetir la preparación anterior con **Imagen 2 falla tres veces**.
2. Confirmar que el proceso se pausa en imagen 2 después de tres intentos.
3. Confirmar que imagen 3 y texto siguen pendientes y no llegaron a WhatsApp.
4. Pulsar **Reanudar desde checkpoint** para continuar con el adaptador real; la inyección no se conserva al reanudar.

## Resultado ambiguo

1. Elegir al menos dos imágenes y seleccionar **Imagen 2 queda ambigua**.
2. Confirmar que el proceso queda pausado en `Verificación pendiente` y no avanza.
3. Pulsar **Reconciliar y reanudar**.
4. Si el mensaje saliente existe, debe confirmarse sin repetirlo. Si WhatsApp aún no ofrece evidencia suficiente, debe seguir pausado.

## Imagen temporal faltante

1. Seleccionar imágenes y elegir **Imagen 1 temporal perdida**.
2. Confirmar el estado `Requiere archivo` sin perder campaña, contacto ni pasos.
3. Volver a elegir el archivo original solicitado y pulsar **Restaurar imágenes**.
4. Reanudar y confirmar que continúa desde ese paso.

## Reinicio del Service Worker

1. Dejar un proceso pausado.
2. Desde `chrome://extensions`, abrir el inspector del Service Worker y detenerlo, o recargar la extensión.
3. Abrir nuevamente el popup.
4. Confirmar que campaña, teléfono enmascarado, pasos, intentos y último checkpoint reaparecen.
5. Reanudar. Ningún paso ya confirmado debe repetirse.

## Diagnóstico de fallos

- `chrome://extensions` → Flor Mía WhatsApp Sender → **Service worker**;
- consola de DevTools de la pestaña de WhatsApp Web;
- estado, intento y error visible debajo de cada paso en el popup.

Los logs registran IDs, pasos, intentos, resultados y códigos de error; no incluyen el texto completo ni el teléfono completo.
