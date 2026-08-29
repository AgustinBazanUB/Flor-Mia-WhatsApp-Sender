# Contact Export 0.9.5.6 — correlación histórica LID → teléfono

## Evidencia real que obliga al cambio

La prueba real de 0.9.5.5 sobre `Wh-Junio/Julio15-2025` encontró 210 miembros estructurados y 18 teléfonos. Para los 192 LID restantes ejecutó 192 intentos de `queryWidExists`, con `serverResolved: 0`, `remaining: 192`, 0 scrolls y 0 chats abiertos.

Esto demuestra que el problema no es el viewport: WhatsApp conserva la membresía de la etiqueta, pero no expone un PN para esos LID mediante esa consulta.

## Cambio de metodología

0.9.5.6 deja de ejecutar `queryWidExists` para LID → PN. En su lugar, después del cache local correlaciona únicamente evidencia fuerte ya sincronizada por WhatsApp:

- metadata alternativa del item de etiqueta;
- metadata del Chat/Contact exacto para ese LID;
- `remoteJidAlt`;
- `participantPn` / `participantAlt`;
- `senderPn`;
- `userReceipt.userJid` de mensajes salientes del chat LID;
- modelos de mensajes ya cargados/sincronizados.

No se inspecciona texto, contenido ni media de los mensajes. No se abre ningún chat y no se hace scroll.

## Fail closed

Un teléfono sólo se acepta cuando está ligado al LID exacto por una de esas relaciones. Si dos evidencias históricas producen teléfonos distintos para un mismo LID, el contacto queda `PHONE_UNRESOLVED`; no se elige uno por heurística.

## Diagnóstico nuevo

- `phoneLookupMethod: history-metadata`
- `phoneLookupServerSkipped: true`
- `phoneHistoryResolved`
- `phoneHistoryMessagesScanned`
- `phoneHistoryChatsPresent`
- `phoneHistoryConflicts`

## Límite real

Si WhatsApp nunca sincronizó un PN para un LID histórico, ningún algoritmo local puede reconstruir ese número a partir de los dígitos del LID. En ese caso se necesita una fuente externa/previa del mapping o esperar una futura interacción que vuelva a incluir PN metadata.
