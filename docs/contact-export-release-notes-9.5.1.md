# Flor Mía WhatsApp Sender 9.5.1 — Contact Export

## Problema corregido

9.5.1 reemplaza el núcleo del extractor de contactos 0.9.5. La auditoría encontró que la versión anterior podía aceptar `#pane-side` como lista inmediatamente después de seleccionar una etiqueta, aunque ese nodo siguiera representando el listado global de chats. Además abría chats/fichas individualmente para intentar resolver teléfonos faltantes.

Eso explicaba dos síntomas:

- una etiqueta de 10 contactos podía terminar con decenas de candidatos externos;
- la extracción era lenta por navegación y esperas visuales contacto por contacto.

## Arquitectura nueva

- **Label scoped:** el listado debe estar asociado a la etiqueta seleccionada; un `#pane-side` global sin transición/evidencia se rechaza.
- **Phone first:** teléfono antes que nombre; JID/atributos semánticos/enlaces locales/valor internacional visible.
- **No chat opening:** el análisis normal no abre cada conversación. `chatsOpened = 0` por diseño.
- **Unresolved seguro:** si no puede demostrar teléfono, queda `PHONE_UNRESOLVED`; no se inventa país/prefijo.
- **Zona literal:** `Zona = labelName`. `Falta enviar` permanece `Falta enviar`.
- **Deduplicación:** teléfono como clave final; nombre nunca es clave.
- **Virtualización:** sólo se desplaza el scrollRoot del scope de etiqueta; se recolectan IDs únicos hasta countHint o final estable.
- **Control de cantidad:** superar un countHint produce `EXTRACTION_SCOPE_BROKEN`; finalizar con otro total produce `LABEL_CONTACT_COUNT_MISMATCH`.
- **Diagnóstico:** reported vs collected, estrategia, etapa, tiempo, contactos/s, filas, scrolls, operaciones visuales y chats abiertos.
- **Reportes:** TXT y JSON saneados, sin nombre/teléfono completo ni conversaciones.
- **XLSX:** se conserva hoja `Contactos` y columnas exactas `Telefono`, `Nombre y Apellido`, `Zona`.

## Lo que no se implementó a propósito

No se enganchó la extensión a endpoints privados ni a módulos internos no documentados de webpack/WhatsApp. La resolución usa información disponible localmente en la superficie accesible. Cuando una fila sólo tiene un identificador opaco que no permite conocer el teléfono de manera confiable, permanece pendiente.

Tampoco se dejó la apertura automática de chats como fallback del análisis rápido. Si alguna vez se incorpora **Resolver pendientes**, debe ser una acción manual independiente.

## Seguridad del sender

No se reemplazó CampaignEngine, ContactEngine ni las garantías de envío. Si el sender necesita abrir/probar/enviar/reconciliar mientras existe una extracción, el Content Script cancela primero la extracción activa.

## Tests 9.5.1

La suite cubre:

- argentino y extranjero;
- número local ambiguo;
- teléfono estructurado;
- JID individual vs grupo;
- contacto sin nombre;
- `PHONE_UNRESOLVED`;
- mismo teléfono repetido;
- mismo nombre con teléfonos distintos;
- Zona literal;
- 10 contactos + rerenders = 10;
- count esperado 10 y recolectado >10 = error de scope;
- etiqueta vacía;
- lista virtualizada;
- diagnóstico sin PII;
- XLSX exacto;
- aislamiento del popup/sender.

## Performance

La mejora no se basa en reducir delays del chat. Se elimina la operación costosa completa:

`fila → abrir chat → esperar → abrir ficha → buscar teléfono`

En 9.5.1 el análisis normal hace:

`etiqueta → lista scoped → leer filas → scroll scoped → deduplicar`

La pantalla mide tiempos reales para poder comparar una sesión de WhatsApp. No se publica una mejora porcentual hasta ejecutar la prueba manual real.

## Criterio de aceptación manual

Antes de usar cientos de contactos, probar una etiqueta cuyo total sea conocido y comprobar:

1. cantidad esperada = cantidad recolectada;
2. `Chats abiertos = 0`;
3. teléfonos correctos;
4. nombre opcional;
5. Zona literal;
6. pendientes informados;
7. XLSX correcto;
8. sender operativo después de la extracción;
9. VERDE en éxito y ROJO + reporte útil ante rotura deliberada.

## Hotfix de validación con sesión real — 2026-08-29

Un reporte real de `Falta Enviar` mostró `Reported contacts: 10`, `Processed count: 1` y `Collected unique contacts: 0`. La causa era doble: el role=list podía no ser el viewport scrollable real y una fila sin JID/teléfono/posición se procesaba como pendiente sin entrar al contador de recorrido.

9.5.1 ahora reevalúa el scroll root por ancestros/viewport, no interpreta un nodo no-scrollable como final de lista, mantiene identidad anónima sólo para recorrido de pendientes (sin convertirla en teléfono válido) y publica resultados parciales para que el diagnóstico conserve `collectedUniqueContacts` aunque la extracción falle.
