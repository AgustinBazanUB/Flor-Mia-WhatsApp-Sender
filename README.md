# Flor Mía WhatsApp Sender

Extensión privada de Google Chrome, Manifest V3, que ejecuta campañas preparadas explícitamente por Flor Mía sobre una sesión de WhatsApp Web iniciada por el usuario.

## Contactos de WhatsApp — 0.9.6

La release 0.9.6 agrega **Paso 1.5 · Agregar contactos por frase** entre la selección de etiquetas y el extractor existente. Usa la búsqueda global estructurada de WhatsApp Web, valida de forma literal `contains` / `exact`, excluye mensajes enviados por el usuario cuando `Solo mensajes recibidos` está activo, deduplica contactos y muestra una vista previa antes de modificar WhatsApp.

Al confirmar, agrega únicamente los contactos `NEW`, verifica la membresía de cada chat, permite pausa/reanudación/cancelación con checkpoint y actualiza el contador de la etiqueta antes de continuar al Paso 2. No elimina otras etiquetas y no abre chat por chat para descubrir la frase.

Documentación: `docs/add-contacts-by-message.md` y `docs/contact-export-release-notes-0.9.6.md`.

## Contactos de WhatsApp — 0.9.5.4

La rama de Contact Export incorpora una página interna **Contactos de WhatsApp → Exportar contactos de WhatsApp**. La versión 0.9.5.4 usa como fuente primaria el **estado local estructurado de etiquetas/chats de WhatsApp** y deja el crawler DOM como fallback. Mantiene el enfoque **label-scoped + phone-first + no-chat-opening**:

- obtiene primero la membresía exacta desde la colección local de la etiqueta cuando está disponible;
- resuelve JID telefónico directo y mapea IDs `@lid` al teléfono mediante datos/módulos locales ya cargados por WhatsApp;
- cuando una lista grande sólo tiene el mapa LID→teléfono del viewport actual, recorre la lista virtualizada (hasta dos barridos) y reconsulta el cache local por bloque, sin abrir chats;
- si esa integración interna no está disponible, usa el adaptador DOM estricto como fallback;
- no abre conversaciones individualmente durante el análisis normal;
- un teléfono no demostrable queda `PHONE_UNRESOLVED` y no se inventa país/prefijo;
- recorre listas virtualizadas desplazando únicamente el contenedor de la etiqueta;
- deduplica por teléfono, no por nombre;
- usa el nombre literal de la etiqueta como `Zona`;
- si WhatsApp informa un total y la extracción lo supera o no coincide al final, termina en ROJO;
- mide tiempo, contactos/s, scrolls, operaciones visuales y chats abiertos;
- mantiene el XLSX local con hoja `Contactos` y columnas `Telefono`, `Nombre y Apellido`, `Zona`.

La causa del problema anterior y las reglas exactas están documentadas en [`docs/whatsapp-contact-export.md`](docs/whatsapp-contact-export.md) y [`docs/contact-export-release-notes-0.9.5.2.md`](docs/contact-export-release-notes-0.9.5.2.md).

> WhatsApp Web no ofrece un contrato DOM público estable para esta función. Los tests automatizados verifican el extractor con DOM controlado, pero la aceptación final exige una prueba con una etiqueta real cuyo total sea conocido.

## Campañas y sender

La extensión no inicia una campaña por recibirla: primero la valida y la deja en estado `received`. El usuario debe ejecutar **Iniciar**, con WhatsApp Web abierto, sesión activa y preflight operativo.

El sender conserva sus garantías de contexto, pestaña vinculada, checkpoints, reconciliación y controles **Iniciar / Pausar / Reanudar / Detener**. Contact Export está desacoplado de `CampaignEngine`; si el sender necesita manipular WhatsApp, una extracción activa se cancela antes de continuar.

## Privacidad

- El sender no incorpora mensajes/listas de destinatarios al reporte técnico.
- Contact Export no usa servicios externos ni endpoints privados de WhatsApp.
- Contact Export no lee contenido de conversaciones.
- Teléfonos, nombres y etiquetas extraídos permanecen en el navegador y sus resultados temporales usan `chrome.storage.session`.
- Los reportes de Contact Export excluyen nombres y teléfonos completos.

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

Los permisos se mantienen acotados a los necesarios para almacenamiento, scheduler, recuperación de Content Scripts, WhatsApp Web y los orígenes autorizados de Flor Mía.

## Flujo de campaña

1. Flor Mía entrega una campaña con destinatarios explícitos, texto y hasta tres imágenes.
2. La extensión valida el contrato, persiste la campaña y guarda los blobs una sola vez.
3. El popup muestra la campaña recibida, pero no la ejecuta automáticamente.
4. **Iniciar** abre de forma segura el primer destinatario pendiente y prueba el contexto antes del contenido.
5. Cada destinatario se delega al `ContactEngine`; sólo un resultado `completed` incrementa progreso y límite diario.
6. Una pausa, error, imagen faltante o estado ambiguo bloquea al siguiente destinatario.
7. **Reanudar** rehidrata el checkpoint y no repite pasos confirmados.
8. **Detener** respeta la frontera segura y la reconciliación necesaria si un envío pudo ocurrir.

Cerrar el popup no modifica el motor. La campaña puede continuar mientras Chrome y WhatsApp Web sigan abiertos, la sesión esté activa y la computadora no esté suspendida.

## Recuperación segura

- Un paso confirmado no vuelve a ejecutarse.
- Antes de enviar, `ConversationContextProof` debe confirmar el destinatario por evidencia fuerte o causal segura; una contradicción bloquea el envío.
- Cada contacto usa una pestaña vinculada durante su unidad activa.
- Un click sin confirmación queda ambiguo y se reconcilia antes de cualquier reintento.
- Una recarga de WhatsApp, pestaña cerrada o sesión cerrada pausa la campaña con causa diferenciada.
- Un selector primario que deja de funcionar pero conserva fallback válido se registra como drift.
- Si se agotan estrategias de una capability crítica, el semáforo pasa a ROJO y la campaña se pausa.
- Al reiniciar el Service Worker se cargan campaña, contador y checkpoint.
- Si faltan blobs, la campaña conserva el progreso y pide restaurar imágenes.

## Verificación

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run validate:build
```

`npm run verify` ejecuta todas esas fases. Los tests automatizados no envían mensajes reales ni prueban la cuenta real de WhatsApp Business.

Documentación adicional: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/WEB-APP-PROTOCOL.md`](docs/WEB-APP-PROTOCOL.md), [`docs/ACCEPTANCE-TESTS.md`](docs/ACCEPTANCE-TESTS.md), [`docs/PRIVACY-SECURITY.md`](docs/PRIVACY-SECURITY.md), [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md), [`docs/MANUAL-TEST.md`](docs/MANUAL-TEST.md) y [`docs/whatsapp-contact-export.md`](docs/whatsapp-contact-export.md).

## Versionado

El proyecto usa SemVer para el paquete. `extensionVersion` identifica el build instalado, `lastKnownGoodExtensionVersion` el último preflight funcional y `protocolVersion` cambia únicamente ante una incompatibilidad del envelope Web-App.

## Limitaciones

- La sesión y el QR siempre se manejan manualmente.
- La confirmación DOM del sender detecta evidencia saliente; no garantiza entrega/lectura en el teléfono.
- WhatsApp Web puede cambiar su DOM y exigir actualizar adaptadores.
- Contact Export 0.9.5.4 deja pendiente únicamente un contacto cuyo teléfono no pueda resolverse ni por la colección local/JID-LID ni por los fallbacks estructurados, sin abrir el chat.
- El reporte técnico no aplica reparaciones automáticamente ni transmite datos a terceros.
- La validación real de campañas requiere destinatarios autorizados; la validación real de Contact Export requiere etiquetas reales conocidas.


### 0.9.5.5 — resolución no visual LID → teléfono

Cuando la membresía estructurada de una etiqueta contiene LID cuyo PN no está en cache, Contact Export ya no intenta depender del viewport ni del scroll. Primero consulta todos los stores locales y, para los LID todavía pendientes, usa la operación interna de WhatsApp Web `WAWebQueryExistsJob.queryWidExists` y vuelve a leer `WAWebApiContact`/LidUtils. No abre chats ni lee mensajes. Los teléfonos sólo se fusionan si el `contactId` pertenece a la membresía estructurada original de la etiqueta.
