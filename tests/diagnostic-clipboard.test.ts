import { describe, expect, it, vi } from "vitest";
import { copyDiagnosticText } from "../src/diagnostics/clipboard";

describe("diagnostic copy logic", () => {
  it("copies only after receiving explicit content and uses the provided browser writer", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await copyDiagnosticText("reporte saneado", { writeText });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("reporte saneado");
  });

  it("rejects empty reports and unavailable clipboard APIs", async () => {
    await expect(copyDiagnosticText("", { writeText: vi.fn() })).rejects.toThrow("No hay contenido");
    await expect(copyDiagnosticText("reporte", null)).rejects.toThrow("no está disponible");
  });
});
