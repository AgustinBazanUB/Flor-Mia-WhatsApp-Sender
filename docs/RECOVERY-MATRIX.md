# Matriz de recuperación

| Interrupción | Estado durable | Recuperación segura |
|---|---|---|
| Antes del click | step `in_progress` sin `sendAttempted` | Puede volver a `pending`; exige contexto válido antes de otro click. |
| Después del click sin evidencia | `verification_pending` | Conserva checkpoint/blobs y reconcilia en la misma pestaña/chat; no avanza ni permite cleanup. |
| Contacto completed antes de guardar campaña | checkpoint `completed` | Aplica contador idempotente y recipient completed sin ejecutar otra vez el contacto. |
| Campaña guardada antes de limpiar checkpoint | recipient y checkpoint `completed` | Limpia el checkpoint redundante; no reenvía ni vuelve a contar. |
| Pestaña vinculada cerrada | checkpoint activo | Pausa como `whatsapp_tab_closed`; no elige otra pestaña automáticamente. |
| Misma pestaña recargada | mismo tab ID, Content Script temporalmente ausente | Pausa/espera, nuevo preflight y prueba de contexto antes de continuar. |
| Alarma de ejecución anterior | `runToken` distinto | Se ignora sin llamar `advance`. |
| Stop durante resultado ambiguo | `stopRequested` + checkpoint incierto | Reconcilia; solo `confirmed`, `not_sent` probado o ausencia de click permiten terminalizar. |

La recuperación implementa **at-most-once unless safely proven not sent**; no afirma exactly-once transaccional con WhatsApp.
