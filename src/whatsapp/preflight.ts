import type { CapabilityResult, WhatsAppPreflightResult } from "../shared/state";
import { findAttachButton, findComposer, findImageFileInput, findMainInterface, findQrCode, findSendButton } from "./selectors";
import { waitForCondition, waitForDocumentReady } from "./wait";

const available = (message: string, selector?: string): CapabilityResult => ({ state: "available", message, ...(selector ? { selector } : {}) });
const unavailable = (message: string): CapabilityResult => ({ state: "unavailable", message });
const requiresContext = (message: string): CapabilityResult => ({ state: "requiresContext", message });

export async function runWhatsAppPreflight(timeoutMs = 8_000): Promise<WhatsAppPreflightResult> {
  const checkedAt = new Date().toISOString();
  const pageDetected = window.location.origin === "https://web.whatsapp.com";
  if (!pageDetected) {
    return {
      checkedAt, pageDetected: false, documentReady: false, sessionReady: false, mainInterfaceReady: false,
      qrDetected: false, operational: false, status: "unavailable", message: "Esta página no es WhatsApp Web.",
      capabilities: {
        openConversation: unavailable("WhatsApp Web no está abierto."),
        composer: unavailable("WhatsApp Web no está abierto."),
        sendText: unavailable("WhatsApp Web no está abierto."),
        multimedia: unavailable("WhatsApp Web no está abierto.")
      }
    };
  }

  let documentReady = document.readyState === "interactive" || document.readyState === "complete";
  if (!documentReady) {
    try {
      await waitForDocumentReady(timeoutMs);
      documentReady = true;
    } catch {
      documentReady = false;
    }
  }

  if (!findQrCode() && !findMainInterface() && !findComposer()) {
    await waitForCondition(
      () => findQrCode() || findMainInterface() || findComposer(),
      { timeoutMs, description: "la pantalla de acceso o la interfaz principal de WhatsApp" }
    ).catch(() => null);
  }

  const qr = findQrCode();
  const main = findMainInterface();
  const composer = findComposer();
  const sendButton = findSendButton();
  const attachButton = findAttachButton();
  const imageInput = findImageFileInput();
  const qrDetected = Boolean(qr);
  const mainInterfaceReady = Boolean(main || composer);
  const sessionReady = mainInterfaceReady && !qrDetected;
  const operational = documentReady && sessionReady;

  let status: WhatsAppPreflightResult["status"] = "loading";
  let message = "WhatsApp Web todavía está cargando.";
  if (qrDetected) {
    status = "login_required";
    message = "WhatsApp Web requiere escanear el código QR manualmente.";
  } else if (operational) {
    status = "ready";
    message = "WhatsApp Web está abierto y la sesión es utilizable.";
  } else if (!documentReady) {
    status = "loading";
  } else {
    status = "loading";
    message = "La página cargó, pero la interfaz principal todavía no está disponible.";
  }

  return {
    checkedAt,
    pageDetected,
    documentReady,
    sessionReady,
    mainInterfaceReady,
    qrDetected,
    operational,
    status,
    message,
    capabilities: {
      openConversation: sessionReady ? available("La navegación a un número está disponible.") : unavailable("Se necesita una sesión iniciada."),
      composer: composer ? available("El campo de escritura fue localizado.", composer.strategy) : requiresContext("Se comprobará al abrir la conversación de prueba."),
      sendText: sendButton ? available("La acción de envío fue localizada.", sendButton.strategy) : requiresContext("El botón aparece cuando el composer contiene texto."),
      multimedia: attachButton || imageInput
        ? available("El mecanismo local de adjuntos fue localizado.", attachButton?.strategy ?? imageInput?.strategy)
        : requiresContext("Se comprobará al abrir una conversación antes de enviar imágenes.")
    }
  };
}
