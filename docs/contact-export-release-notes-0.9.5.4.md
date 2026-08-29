# Contact Export 0.9.5.4

## Evidencia real

La etiqueta `Wh-Junio/Julio15-2025` reportó 210 contactos y 0.9.5.3 recolectó exactamente 210 IDs estructurados, pero sólo resolvió 18 teléfonos; 192 quedaron `PHONE_UNRESOLVED`. La ejecución duró 7 ms y tuvo 0 scrolls, confirmando que la fase estructurada terminaba antes de hidratar la lista virtualizada.

## Corrección

- `labelItemCollection` sigue siendo la única fuente de membresía.
- Se amplían los resolvers locales LID→PN (`getPhoneNumber`, `lidPnCache`, `getLidEntry`, alternate/latest mapping, frontend getter y contact record).
- Cuando quedan LID pendientes, el Content Script recorre sólo el viewport de la etiqueta y reconsulta el cache local después de cada bloque.
- Existe un segundo barrido de seguridad si el primero llega al final con pendientes.
- La fusión de teléfonos exige coincidencia exacta de `contactId` contra los IDs estructurados.
- No se abren chats ni se usan endpoints privados de WhatsApp.
- El reporte final incorpora cantidad intentada, resuelta, remanente y número de consultas de hidratación.

## Seguridad

Un contacto que no pertenece a la colección estructurada nunca puede incorporarse por evidencia DOM. Un LID sin PN demostrable continúa como `PHONE_UNRESOLVED`.
