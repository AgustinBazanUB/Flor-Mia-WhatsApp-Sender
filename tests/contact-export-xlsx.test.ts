import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  buildContactExportWorkbook,
  contactExportFilename,
  CONTACT_EXPORT_HEADERS
} from "../src/contact-export/excel-exporter";

describe("contact export XLSX", () => {
  it("writes exactly the Contactos sheet and the three required columns", () => {
    const bytes = buildContactExportWorkbook({
      contacts: [
        { phone: "+5491123456789", name: "Juan Pérez", zone: "Zona Tribunales" },
        { phone: "+34612345678", name: "", zone: "Zona Tribunales" }
      ],
      selectedLabels: ["Zona Tribunales"],
      date: new Date("2026-08-28T12:00:00-03:00")
    });
    const workbook = XLSX.read(bytes, { type: "array" });
    expect(workbook.SheetNames).toEqual(["Contactos"]);
    const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Contactos!, { header: 1, raw: false });
    expect(rows[0]).toEqual([...CONTACT_EXPORT_HEADERS]);
    expect(rows[1]).toEqual(["+5491123456789", "Juan Pérez", "Zona Tribunales"]);
    expect(rows[2]).toEqual(["+34612345678", "", "Zona Tribunales"]);
  });

  it("keeps the understandable filename contract", () => {
    expect(contactExportFilename(["Zona Tribunales"], new Date(2026, 7, 28))).toBe("flormia_contactos_zona_tribunales_2026-08-28.xlsx");
    expect(contactExportFilename(["Zona Tribunales", "Falta enviar"], new Date(2026, 7, 28))).toBe("flormia_contactos_whatsapp_2026-08-28.xlsx");
  });
});
