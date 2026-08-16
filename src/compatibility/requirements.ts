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
    if (level === "full") {
      required.add("image_file_input");
      required.add("media_preview");
      required.add("media_send_action");
    }
  }
  return required;
}

export const DEFAULT_PREFLIGHT_REQUIREMENTS: CampaignRequirements = {
  needsText: false,
  needsImages: false
};
