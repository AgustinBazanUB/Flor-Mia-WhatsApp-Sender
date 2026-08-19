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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installOptimisticCampaignControls, { once: true });
} else {
  installOptimisticCampaignControls();
}
