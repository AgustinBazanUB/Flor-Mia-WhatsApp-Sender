# Matriz de aceptación A–P

Los casos automatizados usan adaptadores, clock, scheduler/alarmas y storage falsos; nunca envían mensajes. Los casos reales requieren números propios o autorización expresa. “Automatizado” significa que el comportamiento interno pasó en el arnés, no que WhatsApp Web real haya sido validado.

## A. Un contacto, solo texto

- Objetivo: confirmar conversación → texto → evidencia saliente → completed.
- Precondición: sesión GREEN y un número autorizado.
- Pasos: preparar sin imágenes, iniciar y observar el destinatario.
- Esperado: un único texto confirmado; progreso 1/1 y resumen final.
- Evidencia: popup/Web-App, chat autorizado y checkpoint final.
- PASS/FAIL: PASS si existe exactamente un envío confirmado y 1/1; FAIL ante duplicado, bloqueo o progreso parcial contado.
- Estado: automatizado en `contact-engine.test.ts`; manual pendiente.

## B. Un contacto, una imagen y texto

- Objetivo: confirmar pasos separados y texto al final.
- Precondición: capability multimedia GREEN.
- Pasos: preparar una imagen más texto e iniciar.
- Esperado: `image-1` confirmado una vez, luego `text`; progreso solo al terminar ambos.
- Evidencia: orden del checkpoint y chat autorizado.
- PASS/FAIL: PASS si imagen y texto quedan confirmados una sola vez y en ese orden; FAIL en cualquier otro caso.
- Estado: automatizado; manual pendiente.

## C. Un contacto, tres imágenes y texto

- Objetivo: validar orden 1→2→3→texto sin envío agrupado.
- Precondición: tres imágenes pequeñas autorizadas.
- Pasos: preparar/iniciar y seguir los cuatro steps.
- Esperado: cada imagen se envía/verifica por separado; texto último; 1/1.
- Evidencia: checkpoint con cuatro steps y chat.
- PASS/FAIL: PASS si los cuatro steps quedan confirmados en orden y sin agrupación; FAIL ante omisión, reorden o duplicado.
- Estado: automatizado; manual pendiente.

## D. Tres contactos en orden

- Objetivo: validar CampaignEngine multi-contacto secuencial.
- Precondición: tres números autorizados en orden conocido.
- Pasos: iniciar y observar 1/3, 2/3, 3/3.
- Esperado: un solo contacto activo, orden recibido, 100 % solo tras el tercero.
- Evidencia: eventos monotónicos, popup y chats.
- PASS/FAIL: PASS si el orden/progreso es exacto y la concurrencia máxima es uno; FAIL si se salta/repite/solapa un contacto.
- Estado: automatizado en `campaign-engine.test.ts`; manual pendiente.

## E. Pausa y reanudación segura

- Objetivo: evitar cortar/repetir un click ambiguo.
- Precondición: campaña activa con dos o más contactos.
- Pasos: pausar durante un step; esperar frontera; reanudar tras preflight.
- Esperado: `pause_requested`→`paused`; reconciliación si hubo click; no repetir confirmados.
- Evidencia: checkpoint, `PAUSED`/`RESUMED`, llamadas del fake.
- PASS/FAIL: PASS si reanuda el checkpoint correcto sin repetir confirmados; FAIL ante corte ciego, duplicado o avance prematuro.
- Estado: automatizado; manual pendiente.

## F. Fallo recuperable de imagen

- Objetivo: conservar progreso/assets y bloquear contactos posteriores.
- Precondición: campaña con imagen y fallo simulado interno.
- Pasos: hacer fallar imagen 2 una vez y luego agotar intentos.
- Esperado: el primer escenario reintenta solo imagen 2; el segundo pausa y no ejecuta imagen 3/texto/siguiente contacto.
- Evidencia: attempts e historial técnico.
- PASS/FAIL: PASS si los reintentos quedan limitados al step y el siguiente contacto no comienza; FAIL si se repite un step confirmado.
- Estado: automatizado; manual con arnés pendiente.

## G. Conexión offline o WhatsApp no disponible

- Objetivo: clasificar indisponibilidad sin convertirla en rotura DOM.
- Precondición: campaña persistida.
- Pasos: simular offline/pestaña cerrada antes del siguiente contacto.
- Esperado: pausa recuperable, checkpoint intacto, ningún destinatario nuevo.
- Evidencia: `CONNECTION_ERROR`/`whatsapp_tab_closed` y snapshot.
- PASS/FAIL: PASS si pausa y conserva estado sin clasificar UI_CHANGED; FAIL si pierde progreso o avanza.
- Estado: clasificación/scheduler automatizados; offline real pendiente.

## H. Recarga de WhatsApp

- Objetivo: rehidratar sin volver al contacto 1.
- Precondición: primer contacto ya completo o contacto activo con checkpoint.
- Pasos: recargar; esperar; solicitar estado; preflight y reanudar.
- Esperado: `whatsapp_reloading`, misma secuencia/progreso, reconciliación del activo.
- Evidencia: checkpoint antes/después y eventos.
- PASS/FAIL: PASS si vuelve al checkpoint real y reconcilia incertidumbre; FAIL si vuelve al contacto 1 o reenvía a ciegas.
- Estado: recuperación automatizada; recarga real pendiente.

## I. Popup cerrado mientras trabaja

- Objetivo: comprobar que el popup es solo cliente de estado/control.
- Precondición: campaña iniciada.
- Pasos: cerrar el popup; dejar Chrome/WhatsApp activos; reabrirlo.
- Esperado: la campaña no se detiene y el popup rehidrata progreso/checkpoint real.
- Evidencia: progreso antes/después y CampaignScheduler fake.
- PASS/FAIL: PASS si cerrar/reabrir no cambia la ejecución; FAIL si el motor depende del popup.
- Estado: desacoplamiento automatizado; navegador real pendiente.

## J. Trabajar en otra ventana de Chrome

- Objetivo: confirmar que el foco/ventana activa no coordina el scheduler.
- Precondición: campaña en ejecución o espera persistida.
- Pasos: cambiar a otra ventana/pestaña de Chrome; volver después de una alarma.
- Esperado: progreso conservado; controles muestran el estado del Service Worker/stores.
- Evidencia: CampaignScheduler fake y snapshot al volver.
- PASS/FAIL: PASS si cambiar de ventana no altera alarmas/progreso; FAIL si el foco detiene o desvía la campaña.
- Estado: automatizado a nivel arquitectura; manual pendiente.

## K. Rotura funcional de selector/capability

- Objetivo: detenerse en rojo sin avanzar ni perder diagnóstico.
- Precondición: campaña con dos contactos y fault interno del popup.
- Pasos: agotar estrategias requeridas en el health check o step.
- Esperado: GREEN→RED, `whatsapp_ui_changed`, checkpoint/assets retenidos, segundo contacto pendiente.
- Evidencia: Last Known Good, discovery, categoría y reporte.
- PASS/FAIL: PASS si pasa a RED, pausa y retiene evidencia/assets; FAIL si continúa o sobrescribe Last Known Good con un fallo.
- Estado: automatizado; simulación manual pendiente.

## L. Reporte para Codex

- Objetivo: producir evidencia técnica local saneada sin cambiar la campaña.
- Precondición: incidente simulado o real controlado.
- Pasos: abrir Reporte para Codex, revisar Texto/JSON y copiar mediante gesto.
- Esperado: schema estable, categoría/capability/checkpoint/traza útiles; sin teléfono completo, mensaje, binarios, secretos ni envío automático.
- Evidencia: `technical-report.test.ts`, `diagnostic-sanitizer.test.ts` y contenido copiado.
- PASS/FAIL: PASS si el reporte es útil, local y saneado sin mutar campaña; FAIL ante datos sensibles, transmisión o cambio de estado.
- Estado: generación/sanitización automatizadas; flujo UI manual pendiente.

## M. Múltiples pestañas de WhatsApp

- Abrir dos pestañas, iniciar un contacto en A, cambiar orden/foco y confirmar que todos los steps/reconcile siguen en A. Cerrar A debe pausar sin usar B.

## N. Cambio manual de chat

- Cambiar a otro chat después de abrir o antes de Imagen 2. Esperado: `CONTACT_CONTEXT_UNVERIFIED`, ningún click y checkpoint conservado.

## O. Recarga durante un contacto

- Recargar la pestaña vinculada antes y después del marker pre-click. Esperado: mismo tab ID; pre-click puede reanudarse, post-click exige reconciliación y nunca repite a ciegas.

## P. Stop después de un posible click

- Pulsar Detener con `sendAttempted=true`. Esperado: `stopRequested`, estado no terminal, blobs/checkpoint retenidos y `stopped` solo tras reconciliación segura.

## Casos transversales adicionales

- Flor Mía cerrada/reconectada: el motor continúa y `STATUS_REQUEST` devuelve snapshot idempotente con sequence actual.
- Finalización: completed exige todos los destinatarios y ningún checkpoint incompleto; genera resumen/historial y luego borra blobs.
- Retención: paused/error/images_required conservan assets; stop confirmado permite cleanup.
- Daily limit: el contacto activo termina y el siguiente queda bloqueado; el cambio de día reinicia de forma segura.
- Service Worker: rehidratación conserva contador, índice y ambigüedad.

## Criterio de aprobación

Cada caso manual debe registrar fecha, versión 0.9.1 RC, Chrome, condición de WhatsApp, campaña/contactos autorizados (solo IDs en evidencia), resultado PASS/FAIL y observación. Un FAIL de atomicidad, duplicación, origen, privacidad, cleanup o recuperación bloquea la release.
