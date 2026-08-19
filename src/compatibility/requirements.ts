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
  // La firma conserva requirements/level como parte del contrato de preflight; hoy
  // ningún preflight automático puede convertir contenido en una capability invasiva.
  void requirements;
  void level;
  return new Set(BASE);
}

export const DEFAULT_PREFLIGHT_REQUIREMENTS: CampaignRequirements = {
  needsText: false,
  needsImages: false
};
