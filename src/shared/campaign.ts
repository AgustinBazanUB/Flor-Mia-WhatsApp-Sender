import { ERROR_CODES, ExtensionError } from "./errors";
import { normalizePhone } from "./phone";

export const MAX_CAMPAIGN_IMAGES = 3;
export const MAX_CAMPAIGN_RECIPIENTS = 5_000;
export const MAX_CAMPAIGN_MESSAGE_LENGTH = 4_096;
export const MAX_CAMPAIGN_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_CAMPAIGN_ID_LENGTH = 200;
export const MAX_CAMPAIGN_NAME_LENGTH = 200;
export const MAX_CREATED_BY_LENGTH = 120;
export const MAX_RECIPIENT_ID_LENGTH = 200;
export const MAX_CLIENT_ID_LENGTH = 200;
export const MAX_RECIPIENT_NAME_LENGTH = 200;
export const MAX_PHONE_INPUT_LENGTH = 32;
export const MAX_IMAGE_NAME_LENGTH = 255;
export const MAX_IMAGE_TYPE_LENGTH = 100;

export interface CampaignRecipientInput {
  recipientId: string;
  clientId?: string | null;
  name: string;
  phone: string;
  source: "flor_mia" | "excel";
}

export interface CampaignImageInput {
  order: number;
  name: string;
  type: string;
  size: number;
  data: ArrayBuffer;
}

export interface CampaignInput {
  campaignId: string;
  campaignName: string;
  createdBy: string;
  recipients: CampaignRecipientInput[];
  message: string;
  imageCount: number;
  imageOrder: number[];
  images: CampaignImageInput[];
  totalRecipients: number;
}

export interface ValidatedCampaignRecipient extends Omit<CampaignRecipientInput, "phone"> {
  phone: string;
  phoneDigits: string;
  maskedPhone: string;
}

export interface ValidatedCampaign extends Omit<CampaignInput, "recipients"> {
  recipients: ValidatedCampaignRecipient[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExtensionError(ERROR_CODES.invalidInput, `El campo ${field} es obligatorio.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ExtensionError(ERROR_CODES.invalidInput, `El campo ${field} supera ${maxLength} caracteres.`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ExtensionError(ERROR_CODES.invalidInput, `El campo ${field} no es válido.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ExtensionError(ERROR_CODES.invalidInput, `El campo ${field} supera ${maxLength} caracteres.`);
  }
  return normalized;
}

export function validateCampaignInput(value: unknown): ValidatedCampaign {
  if (!isRecord(value)) throw new ExtensionError(ERROR_CODES.invalidInput, "La campaña no tiene un formato válido.");
  const campaignId = requiredText(value.campaignId, "campaignId", MAX_CAMPAIGN_ID_LENGTH);
  const campaignName = requiredText(value.campaignName, "campaignName", MAX_CAMPAIGN_NAME_LENGTH);
  const createdBy = requiredText(value.createdBy, "createdBy", MAX_CREATED_BY_LENGTH);
  const message = typeof value.message === "string" ? value.message.trim() : "";
  if (!Array.isArray(value.recipients) || value.recipients.length === 0) {
    throw new ExtensionError(ERROR_CODES.invalidInput, "La campaña necesita al menos un destinatario.");
  }
  if (value.recipients.length > MAX_CAMPAIGN_RECIPIENTS) {
    throw new ExtensionError(ERROR_CODES.invalidInput, `La campaña supera ${MAX_CAMPAIGN_RECIPIENTS} destinatarios.`);
  }
  const recipients = value.recipients.map((item, index): ValidatedCampaignRecipient => {
    if (!isRecord(item)) throw new ExtensionError(ERROR_CODES.invalidInput, `El destinatario ${index + 1} no es válido.`);
    // La Web-App entrega `whatsappPhone` ya internacionalizado, sin prefijo `+`.
    // Aceptarlo aquí no implica asumir país: todos los dígitos deben venir explícitos.
    const normalized = normalizePhone(requiredText(item.phone, `recipients[${index}].phone`, MAX_PHONE_INPUT_LENGTH), { allowDigitsOnly: true });
    const source = item.source;
    if (source !== "flor_mia" && source !== "excel") {
      throw new ExtensionError(ERROR_CODES.invalidInput, `El origen del destinatario ${index + 1} no es válido.`);
    }
    return {
      recipientId: requiredText(item.recipientId, `recipients[${index}].recipientId`, MAX_RECIPIENT_ID_LENGTH),
      clientId: item.clientId === undefined || item.clientId === null
        ? null
        : optionalText(item.clientId, `recipients[${index}].clientId`, MAX_CLIENT_ID_LENGTH),
      name: optionalText(item.name, `recipients[${index}].name`, MAX_RECIPIENT_NAME_LENGTH),
      phone: normalized.e164,
      phoneDigits: normalized.digits,
      maskedPhone: normalized.masked,
      source
    };
  });
  if (new Set(recipients.map((recipient) => recipient.recipientId)).size !== recipients.length) {
    throw new ExtensionError(ERROR_CODES.invalidInput, "La campaña contiene identificadores de destinatario duplicados.");
  }
  if (message.length > MAX_CAMPAIGN_MESSAGE_LENGTH) {
    throw new ExtensionError(ERROR_CODES.invalidInput, `El mensaje supera ${MAX_CAMPAIGN_MESSAGE_LENGTH} caracteres.`);
  }
  const rawImages = Array.isArray(value.images) ? value.images : [];
  if (rawImages.length > MAX_CAMPAIGN_IMAGES) {
    throw new ExtensionError(ERROR_CODES.invalidInput, `La campaña admite como máximo ${MAX_CAMPAIGN_IMAGES} imágenes.`);
  }
  const images = rawImages.map((item, index): CampaignImageInput => {
    if (!isRecord(item) || !(item.data instanceof ArrayBuffer)) {
      throw new ExtensionError(ERROR_CODES.invalidInput, `La imagen ${index + 1} no contiene datos binarios válidos.`);
    }
    const order = Number(item.order);
    const size = Number(item.size);
    if (!Number.isInteger(order) || order < 1 || !Number.isFinite(size) || size < 0) {
      throw new ExtensionError(ERROR_CODES.invalidInput, `Los metadatos de la imagen ${index + 1} no son válidos.`);
    }
    if (size > MAX_CAMPAIGN_IMAGE_BYTES || item.data.byteLength > MAX_CAMPAIGN_IMAGE_BYTES) {
      throw new ExtensionError(ERROR_CODES.invalidInput, `La imagen ${index + 1} supera 16 MB.`);
    }
    if (size !== item.data.byteLength) {
      throw new ExtensionError(ERROR_CODES.invalidInput, `El tamaño declarado de la imagen ${index + 1} no coincide con sus datos.`);
    }
    if (typeof item.type !== "string" || item.type.length > MAX_IMAGE_TYPE_LENGTH || !item.type.startsWith("image/")) {
      throw new ExtensionError(ERROR_CODES.invalidInput, `El archivo ${index + 1} no es una imagen admitida.`);
    }
    return {
      order,
      name: requiredText(item.name, `images[${index}].name`, MAX_IMAGE_NAME_LENGTH),
      type: item.type,
      size,
      data: item.data
    };
  });
  const imageOrder = Array.isArray(value.imageOrder) ? value.imageOrder.map(Number) : [];
  if (imageOrder.length !== images.length || images.some((image, index) => imageOrder[index] !== image.order)) {
    throw new ExtensionError(ERROR_CODES.invalidInput, "El orden de imágenes no coincide con los archivos recibidos.");
  }
  const imageCount = Number(value.imageCount);
  const totalRecipients = Number(value.totalRecipients);
  if (imageCount !== images.length) throw new ExtensionError(ERROR_CODES.invalidInput, "imageCount no coincide con las imágenes recibidas.");
  if (totalRecipients !== recipients.length) throw new ExtensionError(ERROR_CODES.invalidInput, "totalRecipients no coincide con los destinatarios recibidos.");
  if (!message && images.length === 0) throw new ExtensionError(ERROR_CODES.invalidInput, "La campaña necesita texto o imágenes.");
  return { campaignId, campaignName, createdBy, recipients, message, imageCount, imageOrder, images, totalRecipients };
}
