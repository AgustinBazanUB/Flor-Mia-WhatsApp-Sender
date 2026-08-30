# Changelog

## 0.9.6 — 2026-08-30

### Added

- Paso 1.5 **Agregar contactos por frase** dentro de Contactos → Exportar contactos.
- búsqueda global estructurada de mensajes sin abrir chat por chat;
- modos `contains` y `exact` determinísticos;
- filtro `Solo mensajes recibidos por mí` activado por defecto;
- exclusión de grupos, comunidades, canales, estados y sistema;
- deduplicación por teléfono/contactId/chatId;
- preview antes de modificar WhatsApp;
- detección `NEW` / `ALREADY_IN_LIST` / `UNRESOLVED`;
- asignación explícita y verificada de nuevos contactos a una etiqueta;
- estados `PENDING`, `ADDING`, `ADDED`, `ALREADY_IN_LIST`, `FAILED`;
- hasta 2 intentos por fallo temporal;
- pausa, reanudación, cancelación y checkpoint en `chrome.storage.session`;
- actualización del contador de la lista y sincronización con Contact Export;
- diagnóstico schema v3 con sección `addContactsByMessage`;
- tests específicos de búsqueda, dirección, deduplicación, membresía, checkpoint y asignación.

### Preserved

- detector de etiquetas existente;
- extractor phone-first de 0.9.5.6;
- resolución LID→PN existente;
- XLSX con `Telefono`, `Nombre y Apellido`, `Zona`;
- CampaignEngine / sender, imágenes, texto, pausa/reanudación y diagnóstico previo.

### Security / privacy

- no se solicitan permisos globales nuevos;
- no se usa IA ni servicios externos para decidir coincidencias;
- no se recopilan conversaciones completas;
- la operación de etiquetado añade sólo la lista destino y no elimina otras etiquetas;
- un contacto sólo se marca `ADDED` tras confirmar su membresía.
