export interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export async function copyDiagnosticText(value: string, clipboard: ClipboardWriter | null = navigator.clipboard): Promise<void> {
  if (!value) throw new Error("No hay contenido para copiar.");
  if (!clipboard) throw new Error("El portapapeles no está disponible en este navegador.");
  await clipboard.writeText(value);
}
