import { describe, expect, it } from "vitest";
import { validateCampaignInput } from "../src/shared/campaign";
import { deserializeCampaign, serializeCampaign } from "../src/shared/serialization";

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
});
