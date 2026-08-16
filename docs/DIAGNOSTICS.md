# Diagnóstico, trazas y reporte de reparación

La versión 0.9.1 RC conserva el modelo diagnóstico introducido en 0.5.0: comprueba capacidades funcionales de WhatsApp Web, deriva incidentes específicos y permite producir localmente un reporte saneado para Codex. Su objetivo es detener una campaña de manera segura, conservar evidencia útil y explicar la capability afectada; no intenta ocultar la automatización ni anticipar todas las interfaces futuras.

## Capabilities

El registro cubre página, Content Script, documento listo, sesión, interfaz principal, apertura de conversación, composer, adjuntos, input de imagen, preview multimedia, acciones de envío y estrategias de evidencia saliente.

Cada discovery conserva:

- capability y step lógico;
- estado `available`, `unavailable`, `requires_context` o `not_tested`;
- si es crítica para la campaña actual;
- estrategias intentadas, prioridad, resultado y cantidad de candidatos;
- estrategia elegida y fingerprint funcional cuando hubo éxito;
- descripciones saneadas de una cantidad limitada de candidatos.

El resultado visual no replica esos cuatro estados. Siempre es binario:

- **🟢 VERDE / `GREEN`**: todas las capabilities críticas para la campaña están disponibles;
- **🔴 ROJO / `RED`**: una capability crítica está ausente o no pudo comprobarse de forma confiable.

Las capabilities multimedia no bloquean una campaña solo de texto. Para una campaña con imágenes son críticas.

## Niveles de comprobación

- **Full preflight:** se ejecuta antes de iniciar o reanudar. Abre el destinatario explícito sin enviar, obtiene el contexto real del composer y, si corresponde, prepara/cierra un preview con el blob de la campaña sin accionar envío.
- **Lightweight health check:** se ejecuta en fronteras entre contactos. Comprueba salud y estrategias observables sin crear un preview ni repetir pruebas pesadas.
- **Targeted diagnostic:** permite profundizar una capability después de que una operación real falla y alimentar el reporte estructurado.

## Last Known Good

Después de un resultado realmente funcional se persiste por capability:

- versión de la extensión;
- fecha de último éxito;
- ID de estrategia seleccionada;
- fingerprint del selector;
- fingerprint semántico.

Un fallo nunca sobrescribe este valor. Esto permite comparar el último comportamiento funcional con el discovery actual.

## Drift y break

`drift` significa que cambió la estrategia o fingerprint elegido, pero otra ruta registrada sigue funcionando. El semáforo permanece `GREEN` y el nuevo éxito puede convertirse en Last Known Good.

`break` significa que la página terminó de cargar y ninguna estrategia resolvió una capability crítica. El semáforo pasa a `RED`. Estados de carga, Content Script temporalmente ausente o QR/sesión cerrada se clasifican por separado y no se convierten inmediatamente en `WHATSAPP_UI_CHANGED`.

## Fallo durante campaña

Los códigos específicos son `CAPABILITY_UNAVAILABLE`, `WHATSAPP_UI_CHANGED`, `SELECTOR_STRATEGY_EXHAUSTED` y `PREFLIGHT_FAILED`. Ante uno de ellos:

1. el `ContactEngine` persiste el checkpoint;
2. el `CampaignEngine` no selecciona otro destinatario;
3. la campaña queda pausada con `whatsapp_ui_changed`;
4. el semáforo pasa a `RED`;
5. blobs, progreso y orden permanecen intactos;
6. el popup muestra capability, step, intentos y teléfono enmascarado.

No existe un segundo retry a nivel campaña. La reconciliación y los reintentos de steps siguen perteneciendo exclusivamente al `ContactEngine`.

## DiagnosticIncident y taxonomía

Cuando campaña, contacto o preflight quedan en una condición relevante, `DiagnosticIncident` registra IDs internos, posición, teléfono enmascarado, step, orden de imagen, intentos, acción, último step confirmado, semáforo, capability y error saneado. Se deriva de stores existentes; no crea un segundo checkpoint.

La categoría se obtiene en `diagnostics/taxonomy.ts` y conserva el código original. Distingue `EXTENSION_ERROR`, `TEMPORARY_WHATSAPP_ERROR`, `CONNECTION_ERROR`, `CONTACT_ERROR`, `AUTH_ERROR`, `WHATSAPP_UI_CHANGED`, `AMBIGUOUS_SEND_RESULT`, `RESOURCE_ERROR`, `DAILY_LIMIT`, `USER_PAUSE` y `USER_STOP`.

## TechnicalTraceStore

La traza se guarda en `chrome.storage.local` separada de los blobs. Cada registro contiene tiempos, campaña/contacto/step, intento, acción, resultado, código/categoría, método de verificación, capability, estrategia y duración. La política conserva como máximo 500 registros por campaña y 1.000 globales, deduplica por `traceId` y elimina los más antiguos. Puede limpiar una campaña explícitamente.

Los records del `ContactEngine` se derivan de `checkpoint.history`; no se agrega un segundo sistema de reintentos ni se interceptan clicks.

## TechnicalReportV1

El reporte combina `DiagnosticIncident`, campaña/checkpoint saneados, entorno, preflight, compatibilidad, Last Known Good, current discovery, candidates, drift/break, límite diario, operaciones recientes, trace y recuperación del Service Worker. Usa `reportSchemaVersion: 1`, keys técnicas en inglés y `null` cuando no existe evidencia.

El formato Texto es un prompt de reparación en español. Incluye archivos probables y prohíbe eliminar verificaciones, saltar checkpoints, usar coordenadas o introducir evasión. El JSON se entrega por separado en la misma página interna.

## Evidencia y privacidad

No se almacena HTML completo, texto de conversaciones, contenido de mensajes, nombres detectados en el DOM, cookies, QR, tokens ni teléfonos completos dentro del diagnóstico de compatibilidad.

Un candidato se limita a:

- `tagName`;
- `role`;
- `aria-label` truncado solo cuando coincide con términos funcionales permitidos; de lo contrario queda redactado;
- `data-testid`, `data-icon`, `type` y `contenteditable`;
- una jerarquía corta basada únicamente en tags y atributos técnicos.

Los valores con forma de teléfono se reemplazan por `[REDACTED_PHONE]`. El contexto de campaña usa el número ya enmascarado. La cantidad y longitud de candidatos también están acotadas. La URL de WhatsApp pierde query/hash, el stack normaliza rutas locales y los campos sensibles —incluidos nombres camelCase como `accessToken` o `dataBase64`— quedan redactados.

Por defecto se excluyen la lista de destinatarios, teléfonos completos, mensaje, conversaciones, nombres detectados, HTML, storage de WhatsApp, cookies, tokens, credenciales, QR y binarios/base64. El nombre de campaña es opt-in. Copiar requiere un gesto del usuario y no se solicita permiso global `clipboardWrite`; nada se transmite automáticamente.

## Arnés de desarrollo

El popup puede simular:

- estrategia primaria ausente con fallback funcional;
- rotura total de adjuntos;
- rotura consumible en el próximo health check.

La orden usa el protocolo interno con validación del origen `chrome-extension://.../popup/`. No existe un mensaje Web-App equivalente y el bridge productivo no puede activar la inyección.

La página interna `diagnostics/report.html` ofrece pestañas Texto/JSON y copia local. Su lectura no inicia, pausa, reanuda ni detiene campañas.
