# Arquitectura

## Capas

- `src/campaign/`: máquina de estados, política, store, límite diario, progreso, `CampaignEngine`, scheduler, último evento público e historial terminal acotado.
- `src/engine/`: `ContactEngine` atómico, pasos, checkpoints, reconciliación y reintentos de un destinatario.
- `src/background/campaign-runtime.ts`: composición entre campaña, contacto, preflight, persistencia, IndexedDB y alarmas.
- `src/background/service-worker.ts`: frontera de mensajes Manifest V3 y rehidratación; serializa toda mutación de campaña en una cola single-flight y no contiene la lógica del scheduler.
- `src/background/contact-adapter.ts`: adapta el `ContactEngine` a WhatsApp e IndexedDB.
- `src/content/whatsapp.ts`: frontera interna de diagnóstico, navegación, envío y reconciliación.
- `src/content/web-app-bridge.ts`: puente seguro `window.postMessage` ↔ runtime para orígenes permitidos.
- `src/compatibility/`: requirements contextuales, fingerprints funcionales, Last Known Good, clasificación drift/break y errores técnicos saneados.
- `src/diagnostics/`: incidente estructurado, taxonomía, sanitización, entorno, reporte `TechnicalReportV1`, texto de reparación y página local de exportación.
- `src/whatsapp/`: interacción semántica con el DOM, sin coordenadas, mouse ni teclado físico.
- `src/storage/`: estado/checkpoint/compatibilidad/trazas acotadas en `chrome.storage.local` y blobs temporales en IndexedDB.
- `src/popup/`: cliente de estado y control; no coordina la ejecución.

## Separación CampaignEngine / ContactEngine

```text
Campaña recibida
  -> preflight + inicio explícito
  -> CampaignScheduler despierta por chrome.alarms
  -> CampaignEngine elige el primer pendiente
  -> ContactEngine procesa exactamente un destinatario
  -> checkpoint confirmado
  -> progreso + contador diario
  -> espera persistente o siguiente destinatario
```

El `CampaignEngine` nunca conoce selectores de WhatsApp ni reimplementa reintentos. Cada llamada a `advance()` procesa como máximo un contacto y devuelve después de persistir. El `CampaignScheduler` combina despertares simultáneos, por lo que no existen dos destinatarios concurrentes.

El `ContactEngine` conserva la secuencia `imagen 1 → imagen 2 → imagen 3 → texto`, omitiendo pasos inexistentes. Un paso se confirma únicamente con evidencia DOM de identidad estable y un paso `confirmed` nunca se repite. La semántica no es exactly-once transaccional con WhatsApp: el objetivo es **at-most-once unless safely proven not sent**.

## Máquina de estados de campaña

Estados persistidos: `received`, `ready`, `running`, `pause_requested`, `paused`, `waiting_contact`, `waiting_batch`, `daily_limit_reached`, `images_required`, `error`, `stopped` y `completed`.

Las transiciones se validan en `campaign-state-machine.ts`. No se permite saltar desde una campaña terminal a ejecución ni avanzar al siguiente destinatario cuando el resultado del actual es `verification_pending`, `images_required`, `paused` o `failed`.

Semántica de controles:

- **Iniciar:** solo campaña recibida/válida y preflight operativo; programa el primer pendiente.
- **Pausar:** fija `pauseRequested`. Si hay contacto activo, `ContactEngine` llega a la próxima frontera segura antes de confirmar `paused`.
- **Reanudar:** exige nuevo preflight, recupera espera/checkpoint y continúa el contacto o destinatario correcto.
- **Detener:** fija `stopRequested`; si existe evidencia post-click ambigua, conserva checkpoint/blobs y reconcilia antes de llegar a una frontera segura. `stopped` no es un error.

## Persistencia

`CampaignStore` guarda campaña, nombre, orden y estado de destinatarios, índice/ID activo, último completado, progreso, tanda, flags de control, espera, error, política, contador y timestamps. El teléfono completo normalizado se mantiene únicamente porque es necesario para abrir el chat; las vistas y eventos exponen la versión enmascarada.

El texto se guarda una vez por campaña. Los metadatos de imágenes se guardan en el snapshot y sus `Blob` compartidos en IndexedDB; nunca se copian por destinatario.

Claves principales de `chrome.storage.local`:

- `extensionState`: vista pública resumida para popup y compatibilidad técnica, sin duplicar texto ni queue de destinatarios;
- `activeCampaign`: fuente persistente del scheduler;
- `activeContactCheckpoint`: unidad atómica activa;
- `campaignDailyLimit`: contador diario idempotente;
- `campaignPublicEvent`: último evento/snapshot saneado para la Web-App;
- `campaignPublicEventMeta`: última secuencia y lifecycle publicados, sin cola de eventos;
- `campaignHistory`: hasta 50 resúmenes terminales sin destinatarios ni contenido;
- `whatsappCompatibilityState`: semáforo, último preflight, Last Known Good, drift y último fallo técnico saneado;
- `technicalTraceState`: ring buffer técnico, máximo 500 registros por campaña y 1.000 globales; no contiene mensajes, binarios ni teléfonos completos.
- `webAppCommandLog`: hasta 100 IDs de comandos mutantes, sin payloads privados, para deduplicación persistente.

El schema de `extensionState` es `7` y el de compatibilidad es `2`. La migración elimina la copia legacy de `CampaignState` y preserva campaña/checkpoint en sus stores dedicados. Compatibilidad distingue la versión instalada de `lastKnownGoodExtensionVersion`.

## Diagnóstico y reporte para reparación

`DiagnosticIncident` se deriva del estado real de campaña, checkpoint y compatibilidad. No mantiene una copia manual del step: usa `currentStepId`, intentos, verificación y `lastConfirmedStepId` persistidos. La taxonomía mapea el código original a una categoría de diagnóstico (`WHATSAPP_UI_CHANGED`, `AMBIGUOUS_SEND_RESULT`, `CONNECTION_ERROR`, etc.) sin reemplazar `ERROR_CODES`.

El Service Worker es la frontera de captura y exportación. La página `diagnostics/report.html` es solo un cliente interno: solicita el reporte, alterna Texto/JSON y copia por `navigator.clipboard` después de un clic. No coordina la campaña y cerrar esa página o el popup no altera la ejecución.

`TechnicalReportV1` combina únicamente evidencia disponible:

- incidente, progreso y límite diario saneados;
- checkpoint sin texto, `phoneDigits` ni metadata privada innecesaria;
- preflight, strategies, Last Known Good, current discovery, candidates, drift y breaks;
- conexión local, URL de WhatsApp reducida a origin/path y versión de Chrome reducida a `Chrome/<versión>`;
- últimas operaciones, trazas acotadas y recuperación del Service Worker;
- archivos probables y restricciones explícitas que preservan atomicidad, verificación, checkpoints y prevención de duplicados.

La sanitización es defensa en profundidad y se vuelve a aplicar al construir el reporte. Nombres DOM accidentales, query params, rutas locales, teléfonos, campos sensibles camelCase, data URLs y base64 quedan eliminados o redactados. El nombre de campaña solo aparece con opt-in; la lista de destinatarios y el mensaje completo nunca se exportan.

## Scheduler, tandas y Manifest V3

La política tipada está centralizada en `campaign-policy.ts`. Después de un contacto completado, el motor persiste `wait.until` y usa un `chrome.alarms` ligado a `campaignId + runToken`; una alarma de una vida anterior se ignora. El timeout no vive solo en memoria, así que un Service Worker suspendido puede despertar y continuar desde la frontera persistida.

La alarma no evita suspensión del equipo ni mantiene Chrome abierto. No se ejecuta un bucle infinito y no se inicia una campaña al rehidratarla. Solo una espera ya programada puede reprogramarse automáticamente; un contacto incierto queda pausado.

## Límite diario

`DailyLimitStore` es la fuente de verdad. Un destinatario se cuenta después de que `ContactEngine` retorna `completed`, con clave idempotente `campaignId:recipientId`. El límite se evalúa antes del siguiente contacto; nunca corta el activo.

La fecha usa el calendario local. Cada acción y consulta refresca el contador. Si la fecha cambió, se crea un estado diario nuevo aunque Chrome haya permanecido cerrado durante la medianoche.

## Rehidratación y WhatsApp no disponible

Al iniciar el Service Worker se cargan campaña, contador y checkpoint. Se reutiliza `markInterruptedCheckpointAmbiguous`: un step con envío intentado queda en verificación pendiente y uno anterior al click puede volver a `pending`.

Un checkpoint `completed` permanece durable mientras se registra el contador idempotente y se persiste el recipient completado. Solo después se limpia; una recuperación termina esa aplicación sin volver a ejecutar el `ContactEngine`.

Las causas recuperables se distinguen como `whatsapp_reloading`, `whatsapp_tab_closed`, `whatsapp_session_closed`, `contact_ambiguous` e `images_required`. Todas bloquean el siguiente contacto. Reanudar requiere preflight y conserva el índice real.

Una ausencia durante `document.readyState=loading`, la falta temporal del Content Script o una sesión cerrada no se clasifica como cambio de interfaz. Una rotura se declara cuando la página terminó de cargar y todas las estrategias de una capability crítica quedaron agotadas.

## Compatibilidad funcional

El preflight recibe `campaignRequirements` y un nivel:

- `full`: antes de iniciar o reanudar; valida todas las capabilities críticas para esa campaña;
- `lightweight`: entre destinatarios; comprueba salud sin preparar previews ni repetir pruebas pesadas;
- `targeted`: modelo reservado para profundizar una capability concreta después de un fallo.

Para un inicio real, `CampaignRuntime` ejecuta primero el chequeo base, abre mediante `/send` la conversación del destinatario explícito sin enviar y luego realiza el preflight completo en contexto. Si hay imágenes, reutiliza el primer blob compartido para preparar un preview técnico, detectar su acción de envío y cerrarlo sin hacer clic en enviar.

El `ContactAdapter` vincula una única pestaña de WhatsApp para open/send/reconcile. Después de abrir y justo antes de cada click, `ConversationContextProof` exige una identidad estructurada del destinatario esperado dentro de `#main`; la falta o contradicción bloquea sin click.

`src/whatsapp/selectors.ts` expone un registro por capability. Cada estrategia tiene ID estable, método, prioridad, cantidad de coincidencias, candidato elegido y resultado. El orden favorece accesibilidad y semántica antes de atributos/fallbacks técnicos. Los wrappers históricos (`findComposer`, `findAttachButton`, etc.) delegan al mismo resolver para preservar al `ContactEngine`.

El semáforo es solamente `GREEN` o `RED`:

- `GREEN`: cada capability crítica para la campaña quedó disponible; un fallback válido sigue siendo operativo;
- `RED`: al menos una capability requerida está ausente, no verificada o agotó sus estrategias.

Después de cada comprobación funcional, `CompatibilityManager` persiste por capability un Last Known Good con versión de extensión, estrategia elegida y fingerprints técnico/semántico. Una estrategia distinta que funciona produce `drift` y actualiza el Last Known Good; un fallo produce `break` y nunca reemplaza el último valor funcional.

Si una operación del `ContactEngine` devuelve `CAPABILITY_UNAVAILABLE`, `WHATSAPP_UI_CHANGED`, `SELECTOR_STRATEGY_EXHAUSTED` o `PREFLIGHT_FAILED`, el checkpoint se guarda antes de que el `CampaignEngine` pause con `whatsapp_ui_changed`. No se borra campaña, contacto ni blobs y no se elige otro destinatario. El semáforo global pasa a `RED` con capability, step, intentos y teléfono ya enmascarado.

Ver [`DIAGNOSTICS.md`](DIAGNOSTICS.md) para el modelo de evidencia y sus límites de privacidad.

## Contrato Web-App

Canal `flor_mia_whatsapp_extension`, protocolo versión `1`, con `requestId`/`replyTo`, `campaignId` y `sequence` cuando aplica.

Solicitudes: `FLORMIA_CAMPAIGN_PREPARE`, `FLORMIA_CAMPAIGN_START`, `FLORMIA_CAMPAIGN_PAUSE`, `FLORMIA_CAMPAIGN_RESUME`, `FLORMIA_CAMPAIGN_STOP` y `FLORMIA_CAMPAIGN_STATUS_REQUEST`.

Prepare/Start/Pause/Resume/Stop conservan el `requestId` original hasta el Service Worker y se deduplican en un buffer persistente acotado. Los controles pueden incluir `sequence`; si no coincide con el snapshot actual, se rechazan como stale antes de mutar.

Eventos/respuestas: accepted, started, progress, paused, resumed, completed, error y stopped. El bridge rechaza controles cuyo `campaignId` no coincide con la campaña activa y solo publica estado saneado, sin texto, teléfono completo ni claves idempotentes del límite diario. Solo se persiste el evento más reciente; Flor Mía recupera cualquier evento perdido mediante `STATUS_REQUEST`/PULL y descarta secuencias antiguas.

Ver [`WEB-APP-PROTOCOL.md`](WEB-APP-PROTOCOL.md) para el envelope y [`PRIVACY-SECURITY.md`](PRIVACY-SECURITY.md) para retención/cleanup.

## Seguridad

- sin cookies, credenciales, QR ni tokens;
- sin generación o scraping de destinatarios;
- sin `<all_urls>` ni permisos innecesarios;
- sin automatización del sistema operativo o coordenadas;
- sin técnicas anti-detección o evasión;
- logs técnicos sin texto completo ni teléfono completo.
- candidatos DOM limitados a tag, rol y atributos técnicos permitidos; nunca HTML, contenido del chat, nombre detectado ni teléfono completo.
