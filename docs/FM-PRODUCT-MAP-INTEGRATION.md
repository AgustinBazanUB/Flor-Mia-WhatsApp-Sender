# Flor Mía WhatsApp Sender ↔ FM Product System

Este documento vincula la extensión privada con el Master Product & Architecture Map de Flor Mía.

## Artefactos visuales

- FigJam Master Map: https://www.figma.com/board/m7s3CTQ4mbiFF5fcCwpRP8
- Figma Product UI: https://www.figma.com/design/k5ElHZsMZVwtF3J6KxS61S

## Repositorio principal relacionado

`AgustinBazanUB/App-Integral-FM`

Documentación de producto nueva en la rama equivalente:

`docs/product-system/`

## Frontera de responsabilidades

### FM Web App

Responsable de:

- UX de campañas;
- selección/normalización de destinatarios;
- CRM y clientes;
- mensaje/contenido de campaña;
- persistencia autorizada de snapshots/estado;
- mostrar conexión, controles y progreso;
- reconciliar eventos recibidos.

### Flor Mía WhatsApp Sender

Responsable de:

- bridge con la Web App;
- Service Worker MV3;
- campaña/checkpoints;
- scheduler y límites locales;
- ContactEngine;
- interacción segura con WhatsApp Web;
- preflight/compatibilidad;
- diagnóstico técnico saneado;
- publicación de estado/eventos hacia la Web App.

### WhatsApp Web

Es un sistema externo. No forma parte del código de Flor Mía y su DOM no constituye una API estable.

## Mapa conceptual

`FM Web App -> extensionBridge -> web-app-bridge -> Service Worker -> CampaignEngine -> ContactEngine -> WhatsApp Web`

Retorno:

`WhatsApp Web -> Extension state/event -> Web App reconciliation -> UI / persistencia autorizada`

## Regla arquitectónica

No mover lógica CRM ni lógica de negocio de campañas a la extensión solo para simplificar el bridge.

No mover selectores/DOM de WhatsApp al repositorio principal.

La frontera ya documentada en `WEB-APP-PROTOCOL.md` y `ARCHITECTURE.md` sigue siendo la fuente técnica de implementación; el FM Master Map es su representación de producto/arquitectura visual.

## WhatsApp Inbox

El Product System incluye una propuesta separada de `Redes Sociales -> WhatsApp Inbox`.

Esa propuesta no debe asumirse automáticamente cubierta por el protocolo actual de campañas. Antes de implementar Inbox debe auditarse qué capacidades de lectura/eventos necesita y diseñar una extensión del contrato que preserve:

- privacidad;
- bajo consumo;
- ausencia de polling agresivo;
- separación CRM/DOM;
- grupos/canales y chats no elegibles;
- compatibilidad con campañas activas;
- seguridad ante cambios de WhatsApp Web.

## Estado

Este archivo es documentación de arquitectura y no modifica el runtime, manifest, permisos ni ejecución de la extensión.