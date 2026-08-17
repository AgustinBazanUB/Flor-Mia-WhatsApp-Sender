import type { CampaignRequirements, PreflightLevel, WhatsAppCapability } from "./types";

const BASE: WhatsAppCapability[] = [
  "whatsapp_page",
  "content_script",
  "document_ready",
  "session",
  "main_interface",
  "open_conversation"
];

export function requiredCapabilities(
  requirements: CampaignRequirements,
  level: PreflightLevel
): Set<WhatsAppCapability> {
  const required = new Set(BASE);
  if (requirements.needsText) {
    required.add("composer");
    required.add("outgoing_text_evidence");
    if (level === "full") required.add("text_send_action");
  }
  if (requirements.needsImages) {
    required.add("composer");
    required.add("attachment_action");
    required.add("outgoing_media_evidence");
    // `image_file_input`, `media_preview` y `media_send_action` se verifican
    // dentro del paso atómico de envío con la imagen real. Probarlas aquí
    // requería inyectar una imagen técnica y alterar el estado de WhatsApp;
    // si el preview no podía cerrarse de forma demostrable, el diagnóstico
    // dejaba la UI bloqueada antes de empezar la campaña. El runtime conserva
    // las mismas comprobaciones (archivo exacto, preview, botón habilitado,
    // destinatario y evidencia saliente) inmediatamente antes/después del click.
  }
  return required;
}

export const DEFAULT_PREFLIGHT_REQUIREMENTS: CampaignRequirements = {
  needsText: false,
  needsImages: false
};
