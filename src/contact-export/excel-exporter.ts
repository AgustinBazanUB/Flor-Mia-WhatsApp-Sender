import * as XLSX from "xlsx";
import { CONTACT_EXPORT_ERROR_CODES, type ContactExportWorkbookInput } from "./types";

export const CONTACT_EXPORT_HEADERS = ["Telefono", "Nombre y Apellido", "Zona"] as const;

function datePart(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function safeLabelFilenamePart(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

export function contactExportFilename(selectedLabels: string[], date = new Date()): string {
  const prefix = selectedLabels.length === 1
    ? `flormia_contactos_${safeLabelFilenamePart(selectedLabels[0] || "whatsapp") || "whatsapp"}`
    : "flormia_contactos_whatsapp";
  return `${prefix}_${datePart(date)}.xlsx`;
}

export function buildContactExportWorkbook(input: ContactExportWorkbookInput): Uint8Array {
  const rows: Array<[string, string, string]> = input.contacts.map((contact) => [
    String(contact.phone || ""),
    String(contact.name || ""),
    String(contact.zone || "")
  ]);
  const worksheet = XLSX.utils.aoa_to_sheet([[...CONTACT_EXPORT_HEADERS], ...rows]);
  worksheet["!cols"] = [{ wch: 20 }, { wch: 34 }, { wch: 34 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Contactos");
  const output = XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true });
  return output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer);
}

export function downloadContactExportWorkbook(input: ContactExportWorkbookInput): string {
  try {
    const data = buildContactExportWorkbook(input);
    const filename = contactExportFilename(input.selectedLabels, input.date);
    // Copia a un ArrayBuffer propio para mantener compatibilidad estricta con BlobPart
    // aun cuando los typings de una dependencia declaren ArrayBufferLike.
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    const blob = new Blob([bytes.buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return filename;
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : "No se pudo generar el Excel.");
    Object.assign(wrapped, { code: CONTACT_EXPORT_ERROR_CODES.exportFailed });
    throw wrapped;
  }
}