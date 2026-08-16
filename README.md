# Flor Mía WhatsApp Sender

Extensión privada de Google Chrome, Manifest V3, que ejecuta campañas preparadas explícitamente por Flor Mía sobre una sesión de WhatsApp Web iniciada por el usuario. La versión `0.3.0` incorpora un motor persistente de campañas multi-contacto y conserva el `ContactEngine` atómico de la versión 0.2.0.

La extensión no inicia una campaña por recibirla: primero la valida y la deja en estado `received`. El usuario debe ejecutar **Iniciar**, con WhatsApp Web abierto, sesión activa y preflight operativo.

## Alcance de la versión 0.3.0

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
4. **Iniciar** exige preflight operativo y programa el primer destinatario.
5. Cada destinatario se delega al `ContactEngine`; solo un resultado `completed` incrementa progreso y límite diario.
6. Una pausa, error, imagen faltante o estado ambiguo bloquea al siguiente destinatario.
7. **Reanudar** rehidrata el checkpoint; nunca vuelve al contacto 1 ni repite pasos confirmados.
8. **Detener** confirma una detención de usuario y recién entonces permite descartar los blobs temporales.

Cerrar el popup no modifica el motor. La campaña puede continuar mientras Chrome y WhatsApp Web sigan abiertos, la sesión esté activa y la computadora no esté suspendida.

## Recuperación segura

- Un paso confirmado no vuelve a ejecutarse.
- Un clic sin confirmación queda en `verification_pending` y se reconcilia antes de cualquier reintento.
- Una recarga de WhatsApp, pestaña cerrada o sesión cerrada pausa la campaña con una causa diferenciada.
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

Los tests automatizados usan adaptadores y DOM controlados; no envían mensajes reales. Consultar [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) y [`docs/MANUAL-TEST.md`](docs/MANUAL-TEST.md).

## Limitaciones actuales

- La sesión y el QR siempre se manejan manualmente.
- La confirmación DOM detecta un nuevo saliente; no garantiza entrega ni lectura en el teléfono.
- WhatsApp Web no publica una API DOM estable. Un cambio de interfaz puede exigir actualizar selectores.
- La versión 0.3.0 no incluye fingerprint/versionado de selectores, diagnóstico DOM avanzado, exportación final de diagnóstico ni auditoría end-to-end definitiva; corresponden a los Prompts 4–7.
- La validación real de una campaña requiere cargar `dist/` en Chrome y usar destinatarios autorizados.
