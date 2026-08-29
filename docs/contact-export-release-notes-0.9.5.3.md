# Contact Export 0.9.5.3

## Motivo

Las pruebas reales de 0.9.5.2 mostraron dos fallos distintos:

1. la etiqueta **Falta Enviar** informaba 10 chats/contactos, pero el fallback DOM seleccionado contenía 19 filas visibles y activaba `EXTRACTION_SCOPE_BROKEN`;
2. en etiquetas donde la cantidad sí coincidía, varias filas llegaban como `PHONE_UNRESOLVED` porque WhatsApp usa identificadores `@lid` que no contienen el número telefónico directamente en el DOM.

## Arquitectura nueva

0.9.5.3 usa como fuente primaria el estado estructurado ya cargado localmente por WhatsApp Web:

- `WAWebCollections.Label.getModelsArray()` localiza la etiqueta por nombre exacto;
- `label.labelItemCollection.getModelsArray()` obtiene únicamente sus items y se filtran los de `parentType === "Chat"`;
- se deduplican los `parentId` antes de crear candidatos;
- un JID `@c.us`/`@s.whatsapp.net` entrega el teléfono directamente;
- un `@lid` intenta resolverse primero desde el modelo local del contacto y después mediante `WAWebApiContact.getPhoneNumber` / mapa LID local equivalente;
- el proceso no abre conversaciones y no usa `Contact.find()` ni endpoints de red.

La integración se ejecuta desde el background con `chrome.scripting.executeScript({ world: "MAIN" })` y está encapsulada en `src/contact-export/whatsapp-main-world-resolver.ts`.

## Redundancia y fallback

Las estructuras anteriores son internas y no documentadas por WhatsApp. Si dejan de existir o no pueden leerse, el resolver devuelve `unsupported` y la extensión usa el adaptador DOM existente.

El fallback DOM se endureció: si WhatsApp informa 10 y un candidato de lista ya muestra 19 filas, ese candidato queda descartado inmediatamente y no puede convertirse en scope válido.

## Validación de cantidad

Cuando la estrategia estructurada está disponible, el total de items `Chat` de la etiqueta se compara con el contador confiable detectado en la UI. Una diferencia termina en `LABEL_CONTACT_COUNT_MISMATCH` y no exporta datos dudosos.

## Privacidad

Todo ocurre en la pestaña/localmente. No se envían teléfonos, nombres, etiquetas ni mensajes a servicios externos. No se leen conversaciones. Los reportes continúan excluyendo PII completa.

## Performance

La ruta estructurada normal requiere:

- 0 chats abiertos;
- 0 scrolls;
- 0 clicks por contacto;
- 0 navegación entre conversaciones.

El tiempo real y los teléfonos resueltos deben confirmarse con la cuenta real de Flor Mía después de cargar 0.9.5.3.

## Compatibilidad

No se modifica el contrato del sender de campañas, texto, imágenes, pausa/reanudación, reconciliación ni XLSX.
