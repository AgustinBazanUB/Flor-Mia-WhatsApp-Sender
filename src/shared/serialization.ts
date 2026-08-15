import type { CampaignImageInput, CampaignInput } from "./campaign";

export interface SerializedCampaignImage extends Omit<CampaignImageInput, "data"> {
  dataBase64: string;
}

export interface SerializedCampaignPayload extends Omit<CampaignInput, "images"> {
  images: SerializedCampaignImage[];
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export function serializeCampaign(campaign: CampaignInput): SerializedCampaignPayload {
  return {
    ...campaign,
    images: campaign.images.map(({ data, ...image }) => ({ ...image, dataBase64: arrayBufferToBase64(data) }))
  };
}

export function deserializeCampaign(campaign: SerializedCampaignPayload): CampaignInput {
  return {
    ...campaign,
    images: campaign.images.map(({ dataBase64, ...image }) => ({ ...image, data: base64ToArrayBuffer(dataBase64) }))
  };
}
