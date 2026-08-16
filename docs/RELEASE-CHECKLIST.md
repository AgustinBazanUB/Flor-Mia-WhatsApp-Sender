# Checklist de release 0.9.0 RC

## Automatizado

- [x] versiones sincronizadas en package, lock y manifest;
- [x] migraciones forward de estado/compatibilidad testeadas;
- [x] contrato Web-App, validación y origen testeados;
- [x] secuencia monotónica, stale-ignore y snapshot PULL testeados;
- [x] finalización, historial y cleanup/retención testeados;
- [x] `npm run verify` ejecutado localmente;
- [x] workflow GitHub Actions ejecuta `npm ci` y `npm run verify`.
- [x] contexto de destinatario, tab binding, crash completion, Stop ambiguo y alarmas stale cubiertos por tests;
- [x] comandos mutantes serializados/deduplicados y campaña máxima de 5.000 destinatarios medida;

## Manual con Chrome/WhatsApp real

- [ ] cargar `dist/` sin empaquetar y confirmar versión 0.9.0 RC;
- [ ] ejecutar matriz A–P de `ACCEPTANCE-TESTS.md` con números autorizados;
- [ ] confirmar recepción PUSH y reconexión PULL en Marketing de Flor Mía;
- [ ] confirmar campaña completa y resumen final visible en ambas superficies;
- [ ] probar cierre de popup y reinicio del Service Worker;
- [ ] probar límite diario pequeño y stop confirmado;
- [ ] generar/revisar un reporte de error saneado;
- [ ] revisar que los blobs desaparezcan al completar/detener y permanezcan al pausar/error;
- [ ] inspeccionar consola y storage por ausencia de datos sensibles en eventos;
- [ ] confirmar workflow verde en GitHub sobre el commit publicado;
- [ ] registrar evidencia, versión de Chrome/WhatsApp y resultado por caso.

No declarar la release lista para producción hasta completar todos los ítems manuales aplicables.
