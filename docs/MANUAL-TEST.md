# Prueba manual con una sesión real

Estas pruebas pueden enviar mensajes reales. Usar únicamente números propios o contactos que hayan autorizado expresamente la prueba. Los tests automatizados no reemplazan esta validación.

La matriz de aceptación formal de la versión 0.6.0 está en [`ACCEPTANCE-TESTS.md`](ACCEPTANCE-TESTS.md). Registrar allí evidencia PASS/FAIL; ninguno de esos casos se considera ejecutado contra WhatsApp real por el solo hecho de pasar los tests automatizados.

## Preparación

1. Ejecutar `npm run verify`.
2. Cargar o recargar `dist/` desde `chrome://extensions`.
3. Abrir <https://web.whatsapp.com/>, iniciar sesión manualmente y esperar la lista de chats.
4. Abrir el popup y ejecutar el diagnóstico; página, sesión e interfaz deben estar disponibles.
5. Desde Marketing de Flor Mía, preparar una campaña de texto con tres números autorizados, en un orden fácil de reconocer.
6. Verificar que el popup muestre nombre, `0 / 3`, primer contacto y estado recibido. No debe iniciarse automáticamente.

## Preflight y semáforo 0.4.0–0.6.0

### H. GREEN base y preflight contextual

1. Sin campaña activa, pulsar **Ejecutar diagnóstico** con WhatsApp ya cargado y sesión iniciada.
2. Confirmar **🟢 VERDE** y revisar la lista plegable de capabilities.
3. Preparar una campaña autorizada solo de texto y pulsar **Iniciar**.
4. Confirmar que la extensión abre la conversación del primer destinatario sin enviar, verifica composer/acción/evidencia de texto y recién entonces inicia el motor.
5. Repetir con una campaña que contenga una imagen. Confirmar que aparece y se cierra el preview técnico sin generar un mensaje; la campaña solo inicia si adjuntos, input, preview, acción de envío y evidencia multimedia quedan disponibles.

### I. Fallback funcional y drift

1. En **Simulación de compatibilidad (desarrollo)** seleccionar **Primario falla, usar fallback**.
2. Pulsar **Aplicar escenario**.
3. Confirmar que el diagnóstico sigue en **🟢 VERDE** cuando una estrategia secundaria encuentra la capability.
4. Abrir **Capabilities técnicas** y comprobar la estrategia elegida.
5. Si existía un Last Known Good con otra estrategia, confirmar que el popup informa drift técnico sin agregar un tercer color.
6. Restaurar **Sin simulación** y volver a ejecutar el diagnóstico.

### J. Rotura simulada y RED

1. Seleccionar **Adjuntos sin estrategias → ROJO** y aplicar.
2. Confirmar **🔴 ROJO** y el mensaje “WhatsApp Web no es compatible actualmente con una o más funciones necesarias”.
3. Confirmar que el popup identifica `attachment_action`, su paso lógico y la acción sugerida, sin dumps de DOM.
4. Confirmar que el diagnóstico técnico solo contiene tag/rol/atributos saneados.
5. Restaurar **Sin simulación**.

### K. Pausa automática por health check

1. Preparar una campaña autorizada de al menos dos destinatarios y dejarla en ejecución o en la espera posterior al primero.
2. Seleccionar **Pausar en el próximo health check** y pulsar **Aplicar escenario**. La inyección queda armada para una sola comprobación.
3. En la próxima frontera entre destinatarios, confirmar que la campaña pasa a `paused` con causa `whatsapp_ui_changed`.
4. Confirmar que no comienza el siguiente destinatario, el checkpoint/progreso no retrocede y los assets siguen disponibles.
5. Confirmar **🔴 ROJO**, capability y step en el popup. Un health check ejecutado entre contactos no inventa un teléfono actual; un fallo dentro de un step real sí debe mostrar el teléfono enmascarado y sus intentos.
6. Restaurar **Sin simulación**, ejecutar preflight y reanudar. Confirmar que continúa en el destinatario correcto.

### L. Recarga no es UI_CHANGED

1. Recargar WhatsApp durante una espera o antes del siguiente destinatario.
2. Confirmar que se clasifica como carga temporal (`whatsapp_reloading`) y no como rotura funcional.
3. Al terminar la carga, ejecutar diagnóstico/reanudar y confirmar que un preflight funcional vuelve a **🟢 VERDE**.
4. Cerrar sesión y comprobar que se informa sesión requerida, diferenciada de `WHATSAPP_UI_CHANGED`.

### M. Reporte para Codex 0.6.0

1. En **Simulación de compatibilidad (desarrollo)** seleccionar **Adjuntos sin estrategias → ROJO** y aplicar, o provocar uno de los fallos autorizados del arnés técnico.
2. Confirmar que aparece la ficha de incidente con categoría, posición, ID interno, teléfono enmascarado, step, intentos, último confirmado, semáforo y capability.
3. Pulsar **Generar reporte para Codex**. Debe abrirse `diagnostics/report.html` dentro de la extensión, nunca una página externa.
4. En **Texto**, comprobar el resumen en español y la frase: “Preservar atomicidad, verificación y checkpoints. No reemplazar por clicks ciegos.”
5. Pulsar **Copiar texto**, pegarlo en un editor local y verificar que el contenido coincide.
6. Cambiar a **JSON**, pulsar **Copiar JSON** y confirmar `reportSchemaVersion: 1`, versión `0.6.0`, incidente, checkpoint, compatibilidad, Last Known Good, candidates y trace.
7. Buscar manualmente el teléfono completo, el texto exacto de campaña, nombres de chats, `phone=`, `token`, `cookie`, `base64` y fragmentos de imagen. Ninguno debe aparecer.
8. Confirmar que el nombre de campaña no aparece por defecto. Activar **Incluir el nombre de la campaña** y comprobar que solo ese campo opcional se agrega.
9. Entregar el texto y, si hace falta, el JSON a Codex manualmente. La extensión no debe enviar nada por sí sola.
10. Restaurar **Sin simulación**, ejecutar preflight y confirmar que el reporte no modificó campaña, checkpoint, progreso ni política de reintentos.

## A. Campaña de tres contactos autorizados

1. Pulsar **Iniciar**.
2. Confirmar el orden exacto recibido: contacto 1, 2 y 3.
3. Comprobar progreso `1 / 3`, `2 / 3` y `3 / 3`; un contacto en curso no debe incrementar el porcentaje.
4. Confirmar estado final `completed` y un único mensaje por contacto.

## B. Pausa después del primer contacto

1. Preparar otra campaña autorizada de tres contactos.
2. Iniciar y pulsar **Pausar** mientras el primer contacto esté activo o durante la espera siguiente.
3. Si el clic de envío ya ocurrió, comprobar que ese step se reconcilia/persiste antes de quedar pausado.
4. Confirmar que el segundo contacto no empieza y que el popup indica `paused` o `pause_requested` hasta la frontera segura.

## C. Reanudación

1. Con la campaña anterior pausada, verificar nuevamente que WhatsApp está operativo.
2. Pulsar **Reanudar**.
3. Confirmar que continúa en el step/contacto persistido y que nunca repite el contacto 1 ni pasos confirmados.

## D. Cerrar el popup

1. Iniciar una campaña de tres contactos.
2. Cerrar el popup después de comenzar el primer destinatario.
3. Esperar con Chrome y WhatsApp abiertos.
4. Abrir nuevamente el popup y confirmar que la campaña continuó y muestra el progreso real.

## E. Recargar WhatsApp Web

1. Iniciar una campaña y recargar la pestaña de WhatsApp durante un contacto o antes del siguiente.
2. Confirmar que la campaña no avanza a otro destinatario y conserva el checkpoint actual.
3. Esperar la carga completa y pulsar **Reanudar**; el control ejecuta un preflight nuevo antes de continuar.
4. Confirmar que sigue desde el contacto correcto. Si el clic pudo haber ocurrido, debe reconciliar antes de reenviar.
5. Repetir, si se desea, cerrando la pestaña y cerrando sesión para verificar las causas diferenciadas.

## F. Tanda 3 + pausa

1. Preparar seis contactos autorizados.
2. Iniciar y verificar que los tres primeros se procesan secuencialmente.
3. Confirmar estado `waiting_batch` y pausa aproximada de 15 segundos antes del contacto 4.
4. Confirmar que cerrar el popup durante la espera no altera la tanda.

## G. Límite diario pequeño de desarrollo

No usar 1.000 contactos. Antes de recibir la campaña, abrir el inspector del Service Worker y ejecutar temporalmente:

```js
const { extensionState } = await chrome.storage.local.get("extensionState");
extensionState.config.campaignPolicy.dailyContactLimit = 2;
await chrome.storage.local.set({ extensionState });
```

Luego:

1. Preparar tres contactos autorizados e iniciar.
2. Confirmar que los dos primeros completan y el tercero no empieza.
3. Verificar `daily_limit_reached`, checkpoint/progreso conservado y disponibles en cero.
4. Para restaurar el valor, cambiarlo a `1000` con el mismo procedimiento antes de preparar la siguiente campaña.

## Detención manual

1. Iniciar una campaña y pulsar **Detener**.
2. Si hay un step activo, esperar a que alcance una frontera segura.
3. Confirmar estado `stopped`, ausencia de nuevos destinatarios y conservación del diagnóstico técnico inmediato.
4. Confirmar que no se muestra como error.

## Reinicio del Service Worker

1. Dejar una campaña pausada o en una espera entre contactos/tandas.
2. Detener el Service Worker desde `chrome://extensions` o recargar la extensión.
3. Abrir el popup y confirmar nombre, orden, completados, contador diario, contacto y checkpoint.
4. Reanudar si corresponde; no debe volver al contacto 1.

## Imágenes requeridas

1. Preparar una campaña de prueba con imágenes y provocar/validar la pérdida del blob temporal usando el arnés técnico disponible.
2. Confirmar `images_required` sin avanzar al siguiente destinatario.
3. Re-seleccionar exactamente los archivos pedidos y restaurarlos.
4. Reanudar y comprobar que la campaña conserva el progreso previo.

## Pruebas técnicas preservadas de Prompt 2

La sección de desarrollo del popup mantiene estos casos de un solo contacto:

- solo texto;
- una imagen y texto;
- tres imágenes y texto;
- imagen 2 falla una vez;
- imagen 2 falla tres veces y pausa;
- resultado ambiguo y reconciliación;
- imagen temporal faltante y re-selección;
- reinicio del Service Worker con checkpoint activo.

La inyección de fallos del `ContactEngine` solo se aplica al contacto técnico iniciado desde el popup. El arnés de compatibilidad es independiente: se configura desde una acción interna validada del popup y la Web-App no puede activarlo.

## Diagnóstico

- `chrome://extensions` → Flor Mía WhatsApp Sender → **Service worker**;
- consola de DevTools de WhatsApp Web;
- popup: estado, progreso, contacto, step y errores;
- los logs muestran IDs, steps, intentos, resultados y códigos, pero no el texto completo ni el teléfono completo.
- el detalle completo del modelo está en [`DIAGNOSTICS.md`](DIAGNOSTICS.md).
