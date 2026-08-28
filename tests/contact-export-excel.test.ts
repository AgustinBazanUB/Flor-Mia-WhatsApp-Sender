import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  buildContactExportWorkbook,
  contactExportFilename,
  CONTACT_EXPORT_HEADERS
} from "../src/contact-export/excel-exporter";

describe("contact export XLSX", () => {
  it("creates one Contactos sheet with exactly the required three columns", () => {
    const bytes = buildContactExportWorkbook({
      contacts: [
        { phone: "+5491123456789", name: "Juan Pérez", zone: "Microcentro" },
        { phone: "+34612345678", name: "", zone: "Premium | Tribunales" }
      ],
      selectedLabels: ["Microcentro", "Premium"],
      date: new Date(2026, 7, 28)
    });
    const workbook = XLSX.read(bytes, { type: "array" });
    expect(workbook.SheetNames).toEqual(["Contactos"]);
    const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Contactos!, { header: 1, raw: false });
    expect(rows[0]).toEqual([...CONTACT_EXPORT_HEADERS]);
    expect(rows[1]).toEqual(["+5491123456789", "Juan Pérez", "Microcentro"]);
    expect(rows[2]).toEqual(["+34612345678", "", "Premium | Tribunales"]);
  });

  it("uses the selected label in the filename only when exactly one label is selected", () => {
    const date = new Date(2026, 7, 28);
    expect(contactExportFilename(["Microcentro"], date)).toBe("flormia_contactos_microcentro_2026-08-28.xlsx");
    expect(contactExportFilename(["Microcentro", "Premium"], date)).toBe("flormia_contactos_whatsapp_2026-08-28.xlsx");
  });
});
