# Protocolo Flor Mía ↔ extensión

## Frontera y transporte

El Content Script `web-app-bridge` es la única frontera con Flor Mía. Usa `window.postMessage` solamente en los orígenes exactos de `config/allowed-origins.json` y traduce solicitudes válidas al protocolo interno de Chrome. Canal: `flor_mia_whatsapp_extension`; `protocolVersion`: `1`.

Toda solicitud incluye `channel`, `protocolVersion`, `type`, `requestId` no vacío y `payload`. Los controles incluyen además `campaignId` y pueden enviar la `sequence` del último snapshot como precondición. Las respuestas directas usan `replyTo`; los eventos PUSH no lo usan. `sequence` es entero monotónico por campaña.

Prepare/Start/Pause/Resume/Stop conservan el `requestId` original hasta el Service Worker. Un registro local de hasta 100 entradas deduplica reintentos incluso después de reiniciar el bridge; no guarda payloads. El mismo ID devuelve el snapshot actual equivalente sin repetir el efecto. Si una `sequence` provista ya no coincide, el comando se rechaza como stale y Flor Mía debe consultar estado.

La extensión valida el envelope y la forma del payload en runtime. Rechaza tipos salientes usados como comandos, IDs ausentes, versiones distintas, campañas mal formadas y cualquier clave de inyección de fallos de desarrollo, incluso anidada.

## Solicitudes PULL y controles

| Tipo | Uso | Respuesta |
|---|---|---|
| `FLORMIA_EXTENSION_PING` | Salud y snapshot actual | `FLORMIA_EXTENSION_STATUS` |
| `FLORMIA_EXTENSION_PREFLIGHT_REQUEST` | Diagnóstico nuevo solicitado explícitamente por el usuario | `FLORMIA_EXTENSION_STATUS` actualizado |
| `FLORMIA_CAMPAIGN_PREPARE` | Validar/persistir, sin iniciar | `FLORMIA_CAMPAIGN_ACCEPTED` |
| `FLORMIA_CAMPAIGN_START` | Inicio explícito | `...STARTED` o estado bloqueante |
| `FLORMIA_CAMPAIGN_PAUSE` | Pausa cooperativa | `...PAUSED`/progreso seguro |
| `FLORMIA_CAMPAIGN_RESUME` | Preflight y reanudación | `...RESUMED` o error |
| `FLORMIA_CAMPAIGN_STOP` | Detención de usuario | `...STOPPED` |
| `FLORMIA_CAMPAIGN_STATUS_REQUEST` | Rehidratación/reconexión | `FLORMIA_EXTENSION_STATUS` con snapshot de campaña |

El `campaignId` de un control debe coincidir con la campaña activa. Preparar una campaña distinta mientras existe una no terminal produce conflicto. `PING` es barato y no modifica WhatsApp; `PREFLIGHT_REQUEST` puede inspeccionar capacidades y preparar/cerrar un preview técnico cuando exista una campaña activa con imágenes, por lo que no se ejecuta mediante polling.

Ejemplo de consulta:

```json
{
  "channel": "flor_mia_whatsapp_extension",
  "protocolVersion": 1,
  "type": "FLORMIA_CAMPAIGN_STATUS_REQUEST",
  "requestId": "status-42",
  "campaignId": "campaign-42",
  "payload": {}
}
```

Ejemplo reducido de PUSH (el payload real contiene el snapshot completo):

```json
{
  "channel": "flor_mia_whatsapp_extension",
  "protocolVersion": 1,
  "type": "FLORMIA_CAMPAIGN_PROGRESS",
  "campaignId": "campaign-42",
  "sequence": 18,
  "payload": {
    "campaignId": "campaign-42",
    "sent": 488,
    "total": 1000,
    "remaining": 512,
    "progressPercentage": 48.8,
    "status": "running",
    "sequence": 18
  }
}
```

## Eventos PUSH

La extensión publica `ACCEPTED`, `STARTED`, `PROGRESS`, `PAUSED`, `RESUMED`, `ERROR`, `STOPPED` y `COMPLETED`. En storage conserva solamente el evento público más reciente y metadata de secuencia/lifecycle; no mantiene una cola infinita. Un bridge ignora eventos repetidos o antiguos (`sequence <= última publicada`).

PUSH y PULL transportan el mismo `CampaignPublicStatus`. Si Flor Mía se cierra, el motor sigue fuera del bridge. Al volver, Flor Mía debe enviar `PING` o `STATUS_REQUEST`, aceptar el snapshot completo y luego procesar únicamente eventos con una secuencia superior.

## Snapshot público

`CampaignPublicStatus` contiene:

- identificación y tiempos: `campaignId`, `campaignName`, `receivedAt`, `acceptedAt`, `updatedAt`;
- estado: `status`, `redGreen`, `extensionVersion`, `sequence`;
- progreso: `sent`, `total`, `remaining`, `progressPercentage` y `progress`;
- destinatario actual: índice/ID interno, teléfono enmascarado y nombre solo si una configuración futura lo habilita explícitamente;
- step/checkpoint: `currentStep`, `currentStepId`, `lastConfirmedStepId`;
- tanda y espera: `batch`, `wait`;
- límite: enviados/disponibles y resumen diario sin claves idempotentes internas;
- error: código, categoría, mensaje controlado y recuperabilidad;
- resumen final en `finalSummary` cuando el estado es `completed`.

No incluye texto de campaña, teléfono completo, lista completa de destinatarios, blobs, base64, cookies, tokens, QR, conversaciones, HTML ni `countedContactKeys`.

## Estado de extensión

`FLORMIA_EXTENSION_STATUS` informa `operational`, `message`, `extensionVersion`, `manifestVersion`, `protocolVersion`, límite configurado, enviados/disponibles del día, `overallStatus`, `updatedAt`, posible `errorCode` y el snapshot de campaña o `null`.

## Compatibilidad

SemVer gobierna `extensionVersion`; `protocolVersion` solo cambia ante una incompatibilidad del envelope/protocolo. Campos aditivos conservan el protocolo 1. Los consumidores deben ignorar campos desconocidos y no asumir que recibirán todos los eventos intermedios: PULL es la autoridad de reconexión.

## Errores

Una solicitud rechazada responde con `FLORMIA_CAMPAIGN_ERROR`, `replyTo` y un error saneado `{ code, message, recoverable }`. No inventa una secuencia de campaña. Un error de transporte/bridge no marca la campaña como fallida; Flor Mía puede repetir una consulta PULL con un `requestId` nuevo. Un comando mutador puede repetir el mismo `requestId` para recuperar el resultado sin repetir el efecto. Para una intención nueva debe usar un ID nuevo y la `sequence` del snapshot PULL más reciente.
