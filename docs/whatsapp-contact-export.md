# Exportación de contactos de WhatsApp Business

## Objetivo

Flor Mía WhatsApp Sender incorpora un módulo independiente **Contactos de WhatsApp → Exportar contactos de WhatsApp**. Su objetivo es recorrer etiquetas/listas visibles en la sesión local de WhatsApp Business Web y preparar un archivo Excel para Clientes Fidelizados de Flor Mía.

La función no envía mensajes y no reutiliza CampaignEngine. El sender conserva prioridad: si una campaña necesita volver a manipular WhatsApp mientras existe un análisis de contactos, el Content Script cancela el análisis antes de abrir/enviar/reconciliar contenido.

## Privacidad

- No se usan APIs web externas para procesar datos.
- No se consultan endpoints privados/no documentados de WhatsApp.
- No se extrae ni almacena el contenido de conversaciones.
- Teléfonos, nombres y relaciones con etiquetas se mantienen dentro del navegador.
- Los resultados temporales se guardan en `chrome.storage.session`, no en `chrome.storage.local`, Firebase, GitHub ni Netlify.
- El reporte para Codex no incluye nombres de contactos ni teléfonos completos; usa IDs de correlación anónimos.

## Arquitectura

La implementación está separada en:

- `src/contact-export/whatsapp-contact-adapter.ts`: única capa que conoce la interfaz de WhatsApp Web. Centraliza estrategias semánticas y fallbacks.
- `src/contact-export/phone-normalizer.ts`: normaliza únicamente teléfonos cuyo país está explícito o proviene de un JID personal inequívoco.
- `src/contact-export/contact-deduplicator.ts`: deduplica por teléfono internacional y combina etiquetas.
- `src/contact-export/contact-export-store.ts`: estado temporal en `chrome.storage.session`.
- `src/background/contact-export-runtime.ts`: orquestación de detectar, analizar, cancelar y resumir estado.
- `src/background/contact-export-bootstrap.ts`: listener de background aislado del Service Worker de campañas.
- `src/contact-export/excel-exporter.ts`: generación local del XLSX.
- `src/contact-export/contact-export-diagnostics.ts`: reporte específico para Codex, saneado.
- `src/contact-export/page.ts`: UI completa del módulo.

## Etiquetas y Listas

La UI de WhatsApp puede presentar la organización comercial como **Etiquetas / Labels** o **Listas / Lists**. El adaptador contempla ambos nombres y no hardcodea zonas concretas como Microcentro o Tribunales.

La detección intenta, en orden, encontrar una entrada semántica directa y, cuando hace falta, el menú/herramientas comerciales. Nunca hace click por coordenadas.

## Cómo se determina un contacto

El extractor excluye cuando puede identificar de forma estructurada:

- grupos (`@g.us`);
- estados/broadcast;
- canales/newsletters;
- comunidades;
- elementos de sistema.

Para un contacto individual busca primero evidencia estructurada en la fila/listado. Si el teléfono no está disponible allí, puede seleccionar la conversación y abrir la ficha del contacto para buscar:

1. JID personal (`@c.us` / `@s.whatsapp.net`);
2. enlace `tel:` con número internacional;
3. teléfono internacional visible que comienza con `+`.

No se inspecciona el texto de mensajes.

### Limitación importante

WhatsApp Web no garantiza una API DOM pública estable para enumerar etiquetas/contactos. Por eso la detección real debe validarse manualmente en la cuenta de Flor Mía. Si una fila no expone un teléfono internacional confiable, se informa `PHONE_NOT_AVAILABLE` y no se inventa país/característica.

El fallback que abre la conversación/ficha puede cambiar visualmente el chat seleccionado y, dependiendo de WhatsApp, podría marcar una conversación como leída. Esta es una consecuencia de trabajar únicamente con la interfaz local visible, sin endpoints privados.

## Formato Excel

El archivo contiene exactamente una hoja:

`Contactos`

Y exactamente tres columnas:

| Telefono | Nombre y Apellido | Zona |
| --- | --- | --- |
| +5491123456789 | Juan Pérez | Microcentro |

### Teléfono

Se exporta en una representación internacional consistente (`+` + dígitos) cuando la fuente lo permite. La extensión no agrega silenciosamente código de país ni el indicador móvil argentino.

### Nombre

El nombre puede quedar vacío si existe teléfono confiable pero WhatsApp no muestra un nombre utilizable.

### Zona

Cada etiqueta seleccionada se usa como zona. Un mismo teléfono visto en varias etiquetas se exporta una sola vez y combina las etiquetas de forma legible:

`Microcentro | Premium`

## Compatibilidad con Clientes Fidelizados

Clientes Fidelizados actualmente modela una única zona por cliente (`zoneId` o `customZone`). Por eso se eligió una sola fila por teléfono y una sola celda `Zona`. Si el valor coincide con una zona configurada puede vincularse a ella; si es una combinación como `Microcentro | Premium`, se conserva como zona personalizada.

El importador de Flor Mía debe:

- aceptar exactamente `Telefono`, `Nombre y Apellido`, `Zona`;
- normalizar/validar teléfono;
- deduplicar dentro del archivo;
- comparar con clientes existentes por teléfono;
- mostrar preview antes de confirmar;
- omitir existentes en vez de crear duplicados.

## Progreso y cancelación

Durante el análisis se informa:

- procesados;
- total estimado cuando WhatsApp lo expone;
- porcentaje estimado;
- etiqueta actual;
- número de contacto actual.

La extracción recorre listas virtualizadas mediante scroll semántico y cede el event loop entre cargas. Cancelar aborta el `AbortController` activo y conserva el estado de la extensión.

## Diagnóstico

Errores relevantes:

- `LABELS_NOT_FOUND`
- `CONTACT_LIST_NOT_FOUND`
- `PHONE_NOT_AVAILABLE`
- `CONTACT_EXTRACTION_FAILED`
- `WHATSAPP_NOT_READY`
- `EXPORT_FAILED`
- `CONTACT_EXPORT_CANCELLED`

El módulo puede descargar un `CONTACT EXPORT DIAGNOSTIC` para Codex con:

- versión;
- fecha;
- último paso funcional;
- paso fallido;
- etiqueta;
- estrategia;
- elemento esperado;
- candidatos encontrados;
- cantidad procesada;
- último contacto como ID anónimo;
- error/stack saneado.

## Troubleshooting

### No detecta etiquetas

1. Confirmar que WhatsApp Business Web está autenticado.
2. Abrir manualmente la sección donde WhatsApp muestra Etiquetas/Listas y volver a `Detectar etiquetas`.
3. Si sigue fallando, descargar `Reporte para Codex`.

### Detecta etiqueta pero no contactos

El reporte debe mostrar `CONTACT_LIST_NOT_FOUND` o `CONTACT_EXTRACTION_FAILED` y la estrategia utilizada. No cambiar selectores dispersos: reparar `whatsapp-contact-adapter.ts` y agregar una regresión.

### Hay contactos sin teléfono

No completar manualmente desde el extractor. Revisar si la ficha de WhatsApp muestra un teléfono internacional. Si no hay evidencia suficiente, el contacto debe permanecer en problemáticos.

## Pruebas reales obligatorias

Tests unitarios/build no demuestran la estructura actual de la cuenta real de WhatsApp Business. Antes de usarlo con cientos de contactos se debe validar, como mínimo:

1. una etiqueta con 3 contactos;
2. contacto sin nombre;
3. número argentino;
4. número extranjero;
5. contacto en dos etiquetas;
6. duplicado de un mismo teléfono;
7. etiqueta vacía;
8. múltiples etiquetas;
9. seleccionar todas;
10. WhatsApp cerrado;
11. sesión cerrada;
12. detección rota deliberadamente/fixture de regresión;
13. lote grande observando que la UI mantiene progreso y responde a Cancelar.
