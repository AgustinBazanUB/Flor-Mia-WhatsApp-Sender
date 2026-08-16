# Diagnóstico de compatibilidad

La versión 0.4.0 comprueba capacidades funcionales de WhatsApp Web en lugar de asumir que un selector aislado seguirá existiendo. Su objetivo es detener una campaña de manera segura y explicar la capability afectada; no intenta ocultar la automatización ni anticipar todas las interfaces futuras.

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
- **Targeted diagnostic:** la estructura permite profundizar una capability después de que una operación real falla; el reporte/exportación final se completa en el Prompt 5.

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

## Evidencia y privacidad

No se almacena HTML completo, texto de conversaciones, contenido de mensajes, nombres detectados en el DOM, cookies, QR, tokens ni teléfonos completos dentro del diagnóstico de compatibilidad.

Un candidato se limita a:

- `tagName`;
- `role`;
- `aria-label` truncado solo cuando coincide con términos funcionales permitidos; de lo contrario queda redactado;
- `data-testid`, `data-icon`, `type` y `contenteditable`;
- una jerarquía corta basada únicamente en tags y atributos técnicos.

Los valores con forma de teléfono se reemplazan por `[redacted]`. El contexto de campaña usa el número ya enmascarado. La cantidad y longitud de candidatos también están acotadas.

## Arnés de desarrollo

El popup puede simular:

- estrategia primaria ausente con fallback funcional;
- rotura total de adjuntos;
- rotura consumible en el próximo health check.

La orden usa el protocolo interno con validación del origen `chrome-extension://.../popup/`. No existe un mensaje Web-App equivalente y el bridge productivo no puede activar la inyección.

La infraestructura de esta versión conserva evidencia estructurada y saneada. La exportación JSON y el texto final orientado a reparación pertenecen al Prompt 5.
