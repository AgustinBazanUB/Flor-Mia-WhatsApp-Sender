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
  _requirements: CampaignRequirements,
  _level: PreflightLevel
): Set<WhatsAppCapability> {
  // Un preflight automático sólo puede exigir capacidades observables sin tocar una
  // conversación real. Composer, adjuntos, Send y evidencias se validan dentro del
  // step real después de probar el destinatario, usando el contenido real de campaña.
  return new Set(BASE);
}

export const DEFAULT_PREFLIGHT_REQUIREMENTS: CampaignRequirements = {
  needsText: false,
  needsImages: false
};
