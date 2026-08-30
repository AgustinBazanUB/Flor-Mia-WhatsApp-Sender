# Flor Mía WhatsApp Sender 0.9.6 — Release Notes

## Nueva función

**Contactos → Exportar contactos de WhatsApp → Paso 1.5: Agregar contactos por frase**.

La versión 0.9.6 permite seleccionar una etiqueta, escribir una frase enviada por clientes y obtener una vista previa de contactos únicos antes de agregarlos a la lista.

## Flujo

1. Detectar etiquetas/listas.
2. Seleccionar una sola lista para Paso 1.5.
3. Escribir la frase.
4. Elegir `Contiene esta frase` o `Mensaje exacto`.
5. Mantener activado `Solo mensajes recibidos por mí` cuando se buscan respuestas de clientes.
6. Buscar contactos.
7. Revisar mensajes encontrados, conversaciones únicas, existentes, nuevos y no resolvibles.
8. Confirmar explícitamente `Agregar N contactos a “<lista>”`.
9. Pausar/reanudar/cancelar si hace falta.
10. Actualizar lista.
11. Continuar al Paso 2 del extractor existente.
12. Exportar Excel normalmente.

## Implementación

- búsqueda global estructurada por `WAWebCollections.Msg.search`;
- validación literal local del mensaje;
- `fromMe` como evidencia de dirección;
- clasificación individual/grupo/comunidad/canal/estado;
- resolución telefónica reutilizando el resolver LID→PN de 0.9.5.6;
- deduplicación teléfono → contactId → chatId;
- membresía por `labelItemCollection`;
- asignación sólo `add` de la etiqueta destino;
- verificación posterior de membresía;
- 2 intentos máximos por contacto para fallos temporales;
- checkpoint en `chrome.storage.session`;
- sincronización del contador con Contact Export antes del Paso 2;
- diagnóstico schema v3 con sección `addContactsByMessage`.

## Lo que 0.9.6 no hace

- no usa IA;
- no busca por similitud semántica;
- no abre todos los chats para leer historial;
- no elimina otras etiquetas del contacto;
- no marca `ADDED` sin una comprobación posterior;
- no envía la búsqueda a servidores externos de Flor Mía.

## Pruebas manuales obligatorias antes de promover la release

### Búsqueda

- [ ] Abrir WhatsApp Business Web y verificar sesión iniciada.
- [ ] Abrir Flor Mía WhatsApp Sender 0.9.6.
- [ ] Contactos → Exportar contactos.
- [ ] Detectar listas.
- [ ] Elegir una lista conocida y anotar el total anterior.
- [ ] Escribir una frase que uno o más clientes realmente hayan enviado.
- [ ] Dejar `Solo mensajes recibidos por mí` activado.
- [ ] Buscar.
- [ ] Comprobar que WhatsApp no empieza a abrir chats uno por uno.
- [ ] Verificar que una persona repetida aparece una sola vez.
- [ ] Verificar que grupos/comunidades/canales no aparecen.
- [ ] Verificar un contacto que ya pertenecía a la lista (`YA ESTÁ EN LA LISTA`).
- [ ] Verificar un contacto realmente nuevo (`NUEVO`).

### Asignación

- [ ] Revisar preview antes de modificar WhatsApp.
- [ ] Pulsar `Agregar N contactos a “<lista>”`.
- [ ] Confirmar progreso y contacto actual.
- [ ] Probar Pausar y Reanudar con una lista de prueba suficientemente grande.
- [ ] Confirmar que los contactos ya agregados no se repiten al reanudar.
- [ ] Revisar cualquier `FAILED` y su motivo.
- [ ] Verificar manualmente una muestra de contactos dentro de WhatsApp.
- [ ] Pulsar `Actualizar lista`.
- [ ] Confirmar que el nuevo total coincide razonablemente con los agregados verificados.

### Regresión

- [ ] Paso 2 → Analizar contactos.
- [ ] Confirmar que los nuevos integrantes aparecen.
- [ ] Exportar XLSX.
- [ ] Confirmar columnas `Telefono`, `Nombre y Apellido`, `Zona`.
- [ ] Ejecutar una campaña de prueba del sender anterior.
- [ ] Probar texto, imagen, pausa/reanudación y reporte existente.
- [ ] Confirmar semáforo VERDE si no hubo fallos.

## Si una prueba falla

Descargar desde Contactos:

- `Reporte TXT`
- `Reporte JSON`

Enviar ambos archivos junto con una explicación breve de qué botón se pulsó. No es necesario copiar conversaciones completas.

El reporte 0.9.6 incluye la estrategia, etapa, cantidades y correlaciones anónimas necesarias para investigar el fallo.
