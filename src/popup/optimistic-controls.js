function setPendingControl(kind) {
  const pause = document.getElementById("campaign-pause");
  const resume = document.getElementById("campaign-resume");
  const stop = document.getElementById("campaign-stop");
  const start = document.getElementById("campaign-start");
  const status = document.getElementById("campaign-status");

  for (const button of [pause, resume, stop, start]) {
    if (button instanceof HTMLButtonElement) button.disabled = true;
  }

  if (pause instanceof HTMLButtonElement && kind === "pause") {
    pause.textContent = "Pausando…";
    pause.setAttribute("aria-busy", "true");
  }
  if (stop instanceof HTMLButtonElement && kind === "stop") {
    stop.textContent = "Deteniendo…";
    stop.setAttribute("aria-busy", "true");
  }
  if (status instanceof HTMLElement) {
    status.className = `campaign-status ${kind === "pause" ? "is-pause_requested" : "is-stopping"}`;
    status.textContent = kind === "pause" ? "Pausando…" : "Deteniendo…";
  }
}

function installOptimisticCampaignControls() {
  const pause = document.getElementById("campaign-pause");
  const stop = document.getElementById("campaign-stop");

  pause?.addEventListener("click", () => setPendingControl("pause"));
  stop?.addEventListener("click", () => setPendingControl("stop"));
}

function installContactExportEntry() {
  if (document.getElementById("contact-export-entry")) return;
  const campaignCard = document.getElementById("campaign-card");
  if (!campaignCard) return;

  const card = document.createElement("section");
  card.id = "contact-export-entry";
  card.className = "card campaign-card";

  const heading = document.createElement("div");
  heading.className = "campaign-heading";
  const copy = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Contactos";
  const title = document.createElement("h2");
  title.textContent = "Contactos de WhatsApp";
  copy.append(eyebrow, title);
  heading.append(copy);

  const description = document.createElement("p");
  description.textContent = "Detectá etiquetas o listas de WhatsApp Business y prepará un Excel con teléfono, nombre y zona.";

  const link = document.createElement("a");
  link.className = "button button--secondary button--wide";
  link.href = "../contacts/index.html";
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Exportar contactos de WhatsApp";

  card.append(heading, description, link);
  campaignCard.before(card);
}

function installPopupEnhancements() {
  installOptimisticCampaignControls();
  installContactExportEntry();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installPopupEnhancements, { once: true });
} else {
  installPopupEnhancements();
}
