# Contact Export 0.9.5.5

## Incidente confirmado

El diagnóstico real de 0.9.5.4 encontró 210/210 miembros estructurados en `Wh-Junio/Julio15-2025`, pero sólo 18 PN. La hidratación visual intentó 192 LID durante tres pasadas y resolvió 0; por lo tanto el viewport no era la fuente del mapeo faltante.

## Cambio

- Se elimina la dependencia del scroll para completar PN cuando ya existe membresía estructurada.
- El resolver intenta primero todas las fuentes locales LID↔PN.
- Los LID pendientes se consultan con `WAWebQueryExistsJob.queryWidExists` en lotes de cuatro y luego se revalida el cache local.
- No se abre ningún chat ni se leen mensajes.
- La fusión continúa fail-closed: sólo acepta PN para un `contactId` presente en la membresía estructurada original.
- El diagnóstico separa `phoneLookupLocalResolved`, `phoneLookupServerQueried`, `phoneLookupServerResolved` y `phoneLookupRemaining`.

## Límite real

Si WhatsApp no revela un PN para un LID ni siquiera después de su propia consulta interna, el extractor lo deja `PHONE_UNRESOLVED`. Esto puede ocurrir por privacidad o porque el servidor no entrega una asociación PN para ese LID.
