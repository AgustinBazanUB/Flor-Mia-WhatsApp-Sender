import { describe, expect, it } from "vitest";
import {
  MAX_CAMPAIGN_ID_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_IMAGE_NAME_LENGTH,
  MAX_RECIPIENT_NAME_LENGTH,
  validateCampaignInput
} from "../src/shared/campaign";
import { deserializeCampaign, serializeCampaign } from "../src/shared/serialization";
import { createContactSteps } from "../src/engine/steps";

function campaign() {
  return {
    campaignId: "campaign-1",
    campaignName: "Prueba",
    createdBy: "admin-1",
    recipients: [{ recipientId: "r-1", clientId: "c-1", name: "Cliente", phone: "5491112345678", source: "flor_mia" as const }],
    message: "Hola",
    imageCount: 1,
    imageOrder: [1],
    images: [{ order: 1, name: "uno.png", type: "image/png", size: 3, data: new Uint8Array([1, 2, 3]).buffer }],
    totalRecipients: 1
  };
}

describe("campaign contract", () => {
  it("validates and normalizes recipients", () => {
    const result = validateCampaignInput(campaign());
    expect(result.recipients[0]?.phoneDigits).toBe("5491112345678");
    expect(result.imageOrder).toEqual([1]);
  });

  it("round-trips binary payloads through the runtime-safe representation", () => {
    const decoded = deserializeCampaign(serializeCampaign(campaign()));
    expect([...new Uint8Array(decoded.images[0]!.data)]).toEqual([1, 2, 3]);
  });

  it.each([
    "Hola, esto es una prueba 👋",
    "Árbol, pingüino, acción y corazón ❤️",
    "Línea uno\nLínea dos\nLínea tres",
    "  conserva espacios exteriores  ",
    "Símbolos: ¿¡!?#%&/()[]{}—… € $ @",
    "x".repeat(4_000)
  ])("preserves the exact message through validation and text-step creation", (message) => {
    const validated = validateCampaignInput({ ...campaign(), message });
    expect(validated.message).toBe(message);
    const steps = createContactSteps({
      campaignId: validated.campaignId,
      campaignName: validated.campaignName,
      contact: {
        contactId: validated.recipients[0]!.recipientId,
        phoneDigits: validated.recipients[0]!.phoneDigits,
        maskedPhone: validated.recipients[0]!.maskedPhone
      },
      images: [],
      text: validated.message
    });
    const textStep = steps.find((step) => step.kind === "text");
    expect(textStep?.kind === "text" ? textStep.text : null).toBe(message);
  });

  it("rejects mismatched counts and malformed international numbers", () => {
    expect(() => validateCampaignInput({ ...campaign(), totalRecipients: 2 })).toThrow(/totalRecipients/);
    const invalid = campaign();
    invalid.recipients[0]!.phone = "54-9-inválido";
    expect(() => validateCampaignInput(invalid)).toThrow(/caracteres no admitidos/i);
  });

  it("rejects binary metadata that does not match the received image", () => {
    const invalid = campaign();
    invalid.images[0]!.size = 99;
    expect(() => validateCampaignInput(invalid)).toThrow(/tamaño declarado/i);
  });

  it("rejects oversized identifiers, names and image metadata", () => {
    expect(() => validateCampaignInput({ ...campaign(), campaignId: "x".repeat(MAX_CAMPAIGN_ID_LENGTH + 1) })).toThrow(/campaignId supera/i);
    expect(() => validateCampaignInput({
      ...campaign(),
      recipients: [{ ...campaign().recipients[0], name: "x".repeat(MAX_RECIPIENT_NAME_LENGTH + 1) }]
    })).toThrow(/name supera/i);
    expect(() => validateCampaignInput({
      ...campaign(),
      recipients: [{ ...campaign().recipients[0], clientId: "x".repeat(MAX_CLIENT_ID_LENGTH + 1) }]
    })).toThrow(/clientId supera/i);
    const invalidImage = campaign();
    invalidImage.images[0]!.name = "x".repeat(MAX_IMAGE_NAME_LENGTH + 1);
    expect(() => validateCampaignInput(invalidImage)).toThrow(/images\[0\]\.name supera/i);
  });
});
