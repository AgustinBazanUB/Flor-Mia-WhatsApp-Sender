# Flor Mía WhatsApp Sender

Extensión privada de Google Chrome, Manifest V3, que ejecuta campañas preparadas explícitamente por Flor Mía sobre una sesión de WhatsApp Web iniciada por el usuario. La versión `0.6.0` completa la sincronización PUSH/PULL con Marketing, secuencias monotónicas, finalización/cleanup verificables, historial mínimo, migraciones forward y CI, conservando el `ContactEngine` atómico.

La extensión no inicia una campaña por recibirla: primero la valida y la deja en estado `received`. El usuario debe ejecutar **Iniciar**, con WhatsApp Web abierto, sesión activa y preflight operativo.

## Alcance de la versión 0.6.0

- snapshot público completo y tipado para reconexión de Flor Mía;
- eventos accepted/started/progress/paused/resumed/error/stopped/completed con `sequence` monotónica;
- un único último evento persistido, sin cola creciente y con descarte de eventos stale;
- ejecución independiente de Web-App y popup; PULL rehidrata el estado después de reabrir Marketing;
- finalización estricta: todos los destinatarios completed y ningún checkpoint incompleto;
- historial acotado de 50 campañas sin destinatarios ni contenido;
- cleanup de imágenes después de completed/stopped; retención en paused/error/images_required;
- payloads y orígenes validados en runtime; fault injection rechazada desde producción;
- schemas migrables y `lastKnownGoodExtensionVersion` separado de la versión instalada;
- matriz A–L, documentación del protocolo/privacidad/release y GitHub Actions;

- ficha `DiagnosticIncident` en el popup para campañas pausadas, bloqueadas, detenidas o en error;
- taxonomía central que mapea los `ERROR_CODES` existentes sin sustituirlos;
- `TechnicalTraceStore` persistente con máximo de 500 registros por campaña y 1.000 globales;
- página interna **Reporte para Codex** con vista Texto/JSON y copia mediante gesto del usuario;
- `TechnicalReportV1` estable con campaña/checkpoint saneados, preflight, Last Known Good, discovery, candidates, drift/break, trazas y recuperación del Service Worker;
- exclusión por defecto de destinatarios, teléfonos completos, mensaje, chats, HTML, cookies, tokens, QR y binarios/base64;
- nombre de campaña excluido por defecto y disponible solo mediante opción explícita;
- reporte local: nada se transmite automáticamente y no se agregó permiso de portapapeles;

- preflight contextual completo: una campaña de texto no depende de multimedia y una campaña con imágenes sí la exige;
- semáforo estrictamente binario `GREEN`/`RED`, presentado como **🟢 VERDE** o **🔴 ROJO**;
- registro explícito de capabilities y estrategias ordenadas por accesibilidad, atributos semánticos, estructura y fallbacks técnicos;
- `Last Known Good` persistente por capability y detección separada de drift funcional y rotura real;
- diagnósticos dirigidos con capability, step, estrategias agotadas y candidatos DOM saneados;
- health check liviano entre destinatarios, sin ejecutar un preflight pesado antes de cada step;
- pausa segura ante una rotura de interfaz, conservando checkpoint, destinatario, assets y progreso;
- arnés de desarrollo del popup para simular fallback, semáforo rojo y pausa automática sin modificar WhatsApp real;
- destinatarios procesados secuencialmente y en el orden recibido;
- exactamente un `ContactEngine` activo por vez;
- de cero a tres imágenes separadas y texto al final por destinatario;
- progreso basado exclusivamente en destinatarios completamente confirmados;
- controles **Iniciar**, **Pausar**, **Reanudar** y **Detener**;
- pausa cooperativa en fronteras seguras, sin abortar a ciegas un clic que pudo ocurrir;
- tandas y esperas persistentes mediante `chrome.alarms`;
- límite diario local, persistente e idempotente;
- recuperación después de terminar el Service Worker o recargar WhatsApp Web;
- imágenes compartidas por campaña en IndexedDB, sin duplicarlas por contacto;
- eventos de estado y controles de campaña en el puente de la Web-App;
- arnés técnico de Prompt 2 preservado para probar un solo contacto e inyectar fallos.

Configuración inicial centralizada:

| Opción | Valor |
|---|---:|
| Contactos por tanda | 3 |
| Pausa entre contactos | 1.500 ms |
| Pausa entre tandas | 15.000 ms |
| Límite diario | 1.000 completados |
| Espera de carga de WhatsApp | 30.000 ms |

Estas esperas son controles de ritmo y estabilidad. No son mecanismos de evasión y la extensión no implementa técnicas anti-detección.

## Requisitos y build

- Google Chrome 120 o superior.
- Node.js 20 o superior.
- Una sesión de WhatsApp o WhatsApp Business iniciada manualmente en <https://web.whatsapp.com/>.

```bash
npm install
npm run verify
```

El build cargable queda en `dist/`. Para desarrollo continuo, usar `npm run dev`.

## Cargar en Chrome

1. Abrir `chrome://extensions`.
2. Activar **Modo desarrollador**.
3. Elegir **Cargar extensión sin empaquetar**.
4. Seleccionar la carpeta `dist/`.
5. Después de cada build, pulsar **Recargar** en la tarjeta de la extensión.
6. Abrir WhatsApp Web y completar manualmente el QR si corresponde.

Los únicos permisos de extensión son `storage` y `alarms`; el único host de WhatsApp es `https://web.whatsapp.com/*`. Los orígenes autorizados de Flor Mía están en [`config/allowed-origins.json`](config/allowed-origins.json).

## Flujo de campaña

1. Flor Mía entrega una campaña con destinatarios explícitos, texto y hasta tres imágenes.
2. La extensión valida el contrato, persiste la campaña y guarda los blobs una sola vez.
3. El popup muestra la campaña recibida, pero no la ejecuta automáticamente.
4. **Iniciar** abre de forma segura el primer destinatario pendiente, ejecuta el preflight contextual sin enviar contenido y solo programa el contacto si el resultado es `GREEN`.
5. Cada destinatario se delega al `ContactEngine`; solo un resultado `completed` incrementa progreso y límite diario.
6. Una pausa, error, imagen faltante o estado ambiguo bloquea al siguiente destinatario.
7. **Reanudar** rehidrata el checkpoint; nunca vuelve al contacto 1 ni repite pasos confirmados.
8. **Detener** confirma una detención de usuario y recién entonces permite descartar los blobs temporales.

Cerrar el popup no modifica el motor. La campaña puede continuar mientras Chrome y WhatsApp Web sigan abiertos, la sesión esté activa y la computadora no esté suspendida.

## Recuperación segura

- Un paso confirmado no vuelve a ejecutarse.
- Un clic sin confirmación queda en `verification_pending` y se reconcilia antes de cualquier reintento.
- Una recarga de WhatsApp, pestaña cerrada o sesión cerrada pausa la campaña con una causa diferenciada.
- Un selector primario que deja de funcionar pero conserva un fallback válido se registra como drift y permanece `GREEN`.
- Si se agotan todas las estrategias de una capability crítica, el semáforo pasa a `RED`, la campaña se pausa en una frontera segura y no avanza al siguiente contacto.
- Al reiniciar el Service Worker se cargan campaña, contador y checkpoint. Una operación incierta no se reanuda automáticamente.
- Si faltan blobs, la campaña pasa a `images_required` y conserva todo el progreso hasta re-seleccionarlos.
- El día local se compara al comenzar acciones y consultar estado; el contador se reinicia aunque Chrome no haya estado abierto a medianoche.

## Verificación

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run validate:build
```

Los tests automatizados usan adaptadores y DOM controlados; no envían mensajes reales. Consultar [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/WEB-APP-PROTOCOL.md`](docs/WEB-APP-PROTOCOL.md), [`docs/ACCEPTANCE-TESTS.md`](docs/ACCEPTANCE-TESTS.md), [`docs/PRIVACY-SECURITY.md`](docs/PRIVACY-SECURITY.md), [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md) y [`docs/MANUAL-TEST.md`](docs/MANUAL-TEST.md).

## Versionado

El proyecto usa SemVer. PATCH corrige sin cambiar el contrato; MINOR agrega comportamiento/campos compatibles; MAJOR se reserva para cambios incompatibles. `extensionVersion` identifica el build instalado, `lastKnownGoodExtensionVersion` el último preflight funcional GREEN y `protocolVersion` cambia únicamente si el envelope Web-App deja de ser compatible.

## Limitaciones actuales

- La sesión y el QR siempre se manejan manualmente.
- La confirmación DOM detecta un nuevo saliente; no garantiza entrega ni lectura en el teléfono.
- WhatsApp Web no publica una API DOM estable. La extensión detecta roturas funcionales y se detiene con seguridad, pero un cambio real puede exigir actualizar el registro de selectores.
- El reporte orienta una reparación, pero no aplica cambios automáticamente ni transmite datos a Codex o a otro servidor.
- La inclusión del nombre de campaña es opt-in; el texto y la lista de destinatarios nunca forman parte del reporte.
- La captura DOM avanzada y la auditoría end-to-end definitiva continúan fuera de esta etapa.
- La validación real de una campaña requiere cargar `dist/` en Chrome y usar destinatarios autorizados.
