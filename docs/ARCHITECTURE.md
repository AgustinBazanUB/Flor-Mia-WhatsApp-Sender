# Arquitectura

## Capas

- `src/campaign/`: máquina de estados, política, store, límite diario, progreso, `CampaignEngine`, scheduler y eventos públicos.
- `src/engine/`: `ContactEngine` atómico, pasos, checkpoints, reconciliación y reintentos de un destinatario.
- `src/background/campaign-runtime.ts`: composición entre campaña, contacto, preflight, persistencia, IndexedDB y alarmas.
- `src/background/service-worker.ts`: frontera de mensajes Manifest V3 y rehidratación; no contiene la lógica del scheduler.
- `src/background/contact-adapter.ts`: adapta el `ContactEngine` a WhatsApp e IndexedDB.
- `src/content/whatsapp.ts`: frontera interna de diagnóstico, navegación, envío y reconciliación.
- `src/content/web-app-bridge.ts`: puente seguro `window.postMessage` ↔ runtime para orígenes permitidos.
- `src/whatsapp/`: interacción semántica con el DOM, sin coordenadas, mouse ni teclado físico.
- `src/storage/`: estado/checkpoint en `chrome.storage.local` y blobs temporales en IndexedDB.
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

El `ContactEngine` conserva la secuencia `imagen 1 → imagen 2 → imagen 3 → texto`, omitiendo pasos inexistentes. Un paso se confirma únicamente con evidencia DOM y un paso `confirmed` nunca se repite.

## Máquina de estados de campaña

Estados persistidos: `received`, `ready`, `running`, `pause_requested`, `paused`, `waiting_contact`, `waiting_batch`, `daily_limit_reached`, `images_required`, `error`, `stopped` y `completed`.

Las transiciones se validan en `campaign-state-machine.ts`. No se permite saltar desde una campaña terminal a ejecución ni avanzar al siguiente destinatario cuando el resultado del actual es `verification_pending`, `images_required`, `paused` o `failed`.

Semántica de controles:

- **Iniciar:** solo campaña recibida/válida y preflight operativo; programa el primer pendiente.
- **Pausar:** fija `pauseRequested`. Si hay contacto activo, `ContactEngine` llega a la próxima frontera segura antes de confirmar `paused`.
- **Reanudar:** exige nuevo preflight, recupera espera/checkpoint y continúa el contacto o destinatario correcto.
- **Detener:** fija `stopRequested`; si existe contacto activo espera la misma frontera segura. `stopped` no es un error.

## Persistencia

`CampaignStore` guarda campaña, nombre, orden y estado de destinatarios, índice/ID activo, último completado, progreso, tanda, flags de control, espera, error, política, contador y timestamps. El teléfono completo normalizado se mantiene únicamente porque es necesario para abrir el chat; las vistas y eventos exponen la versión enmascarada.

El texto se guarda una vez por campaña. Los metadatos de imágenes se guardan en el snapshot y sus `Blob` compartidos en IndexedDB; nunca se copian por destinatario.

Claves principales de `chrome.storage.local`:

- `extensionState`: vista global para popup y compatibilidad técnica;
- `activeCampaign`: fuente persistente del scheduler;
- `activeContactCheckpoint`: unidad atómica activa;
- `campaignDailyLimit`: contador diario idempotente;
- `campaignPublicEvent`: último evento saneado para la Web-App.

## Scheduler, tandas y Manifest V3

La política tipada está centralizada en `campaign-policy.ts`. Después de un contacto completado, el motor persiste `wait.until` y usa un `chrome.alarms` con nombre ligado a la campaña. El timeout no vive solo en memoria, así que un Service Worker suspendido puede despertar y continuar desde la frontera persistida.

La alarma no evita suspensión del equipo ni mantiene Chrome abierto. No se ejecuta un bucle infinito y no se inicia una campaña al rehidratarla. Solo una espera ya programada puede reprogramarse automáticamente; un contacto incierto queda pausado.

## Límite diario

`DailyLimitStore` es la fuente de verdad. Un destinatario se cuenta después de que `ContactEngine` retorna `completed`, con clave idempotente `campaignId:recipientId`. El límite se evalúa antes del siguiente contacto; nunca corta el activo.

La fecha usa el calendario local. Cada acción y consulta refresca el contador. Si la fecha cambió, se crea un estado diario nuevo aunque Chrome haya permanecido cerrado durante la medianoche.

## Rehidratación y WhatsApp no disponible

Al iniciar el Service Worker se cargan campaña, contador y checkpoint. Se reutiliza `markInterruptedCheckpointAmbiguous`: un step con envío intentado queda en verificación pendiente y uno anterior al click puede volver a `pending`.

Las causas recuperables se distinguen como `whatsapp_reloading`, `whatsapp_tab_closed`, `whatsapp_session_closed`, `contact_ambiguous` e `images_required`. Todas bloquean el siguiente contacto. Reanudar requiere preflight y conserva el índice real.

## Contrato Web-App

Canal `flor_mia_whatsapp_extension`, protocolo versión `1`, con `requestId`/`replyTo`, `campaignId` y `sequence` cuando aplica.

Solicitudes: `FLORMIA_CAMPAIGN_PREPARE`, `FLORMIA_CAMPAIGN_START`, `FLORMIA_CAMPAIGN_PAUSE`, `FLORMIA_CAMPAIGN_RESUME`, `FLORMIA_CAMPAIGN_STOP` y `FLORMIA_CAMPAIGN_STATUS_REQUEST`.

Eventos/respuestas: accepted, started, progress, paused, completed, error y cancelled. El bridge rechaza controles cuyo `campaignId` no coincide con la campaña activa y solo publica estado saneado, sin texto ni teléfono completo.

## Seguridad

- sin cookies, credenciales, QR ni tokens;
- sin generación o scraping de destinatarios;
- sin `<all_urls>` ni permisos innecesarios;
- sin automatización del sistema operativo o coordenadas;
- sin técnicas anti-detección o evasión;
- logs técnicos sin texto completo ni teléfono completo.
