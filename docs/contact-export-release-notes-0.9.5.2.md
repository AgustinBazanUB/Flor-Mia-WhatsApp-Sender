# Contact Export 0.9.5.2

## Motivo

Una prueba real con la etiqueta **Falta Enviar** informó 10 contactos, pero 9.5.1 seleccionó un `role=list` semánticamente cercano que sólo exponía una fila. El extractor llegó a `validate_label_count` con `collectedUniqueContacts=1`, `rowScans=3` y `scrollOperations=0`.

## Corrección

- Los posibles listados de una etiqueta se evalúan y puntúan antes de elegir uno.
- Un listado no scrollable con menos filas que el contador informado ya no puede aceptarse como scope válido.
- Se prioriza `#pane-side` sólo cuando existe evidencia de que cambió después de seleccionar la etiqueta.
- La extracción espera más ciclos y fuerza un último nudge de renderizado antes de declarar fin prematuro.
- Los reportes incorporan datos técnicos no privados del viewport/listado elegido: cantidad de candidatos DOM, filas visibles, estado y geometría de scroll.
- `whatsapp.action_failed` informa el código específico de Contact Export y la etapa, manteniendo separado el código base de transporte.

## Privacidad

Los nuevos datos de diagnóstico son únicamente estructurales. No incluyen nombres de contactos, teléfonos, mensajes, cookies ni tokens.

## Compatibilidad

El sender de campañas, texto, imágenes, pausa/reanudación, reconciliación y XLSX no cambia su contrato.
