import { isAllowedWebAppOrigin } from "../config/origins";
import { validateCampaignInput } from "../shared/campaign";
import { serializeError } from "../shared/errors";
import { logger } from "../shared/logger";
import {
  INTERNAL_MESSAGE_TYPES,
  isWebAppInboundEnvelope,
  PROTOCOL_VERSION,
  sendRuntimeRequest,
  WEB_APP_CHANNEL,
  WEB_APP_MESSAGE_TYPES,
  type WebAppEnvelope
} from "../shared/protocol";
import { serializeCampaign } from "../shared/serialization";
import { CAMPAIGN_EVENT_KEY, type CampaignPublicEvent } from "../campaign/events";
import type { CampaignPublicStatus } from "../campaign/campaign-types";

function post(message: WebAppEnvelope): void {
  window.postMessage(message, window.location.origin);
}

function responseEnvelope(
  request: WebAppEnvelope,
  type: WebAppEnvelope["type"],
  payload: Record<string, unknown>,
  extra: Pick<WebAppEnvelope, "sequence"> = {}
): WebAppEnvelope {
  return {
    channel: WEB_APP_CHANNEL,
    protocolVersion: PROTOCOL_VERSION,
    type,
    replyTo: request.requestId,
    ...(request.campaignId ? { campaignId: request.campaignId } : {}),
    ...extra,
    payload
  };
}

async function handleRequest(request: WebAppEnvelope): Promise<void> {
  if (request.type === WEB_APP_MESSAGE_TYPES.ping) {
    const status = await sendRuntimeRequest("web-app-bridge", INTERNAL_MESSAGE_TYPES.webAppPing, {});
    post(responseEnvelope(request, WEB_APP_MESSAGE_TYPES.status, status));
    return;
  }
  if (request.type === WEB_APP_MESSAGE_TYPES.prepare) {
    const campaign = validateCampaignInput(request.payload);
    const accepted = await sendRuntimeRequest(
      "web-app-bridge",
      INTERNAL_MESSAGE_TYPES.webAppPrepareCampaign,
      serializeCampaign(campaign)
    );
    post(responseEnvelope(request, WEB_APP_MESSAGE_TYPES.accepted, accepted));
    return;
  }
  if (request.type === WEB_APP_MESSAGE_TYPES.cancelRequest) {
    const campaignId = request.campaignId || String(request.payload.campaignId || "");
    const stopped = await sendRuntimeRequest("web-app-bridge", INTERNAL_MESSAGE_TYPES.campaignStop, { campaignId });
    post(responseEnvelope(request, eventType(stopped), stopped as unknown as Record<string, unknown>, { sequence: stopped.sequence }));
    return;
  }
  const campaignId = request.campaignId || String(request.payload.campaignId || "");
  const controls = {
    [WEB_APP_MESSAGE_TYPES.startRequest]: INTERNAL_MESSAGE_TYPES.campaignStart,
    [WEB_APP_MESSAGE_TYPES.pauseRequest]: INTERNAL_MESSAGE_TYPES.campaignPause,
    [WEB_APP_MESSAGE_TYPES.resumeRequest]: INTERNAL_MESSAGE_TYPES.campaignResume,
    [WEB_APP_MESSAGE_TYPES.stopRequest]: INTERNAL_MESSAGE_TYPES.campaignStop
  } as const;
  if (request.type in controls) {
    const type = controls[request.type as keyof typeof controls];
    const status = await sendRuntimeRequest("web-app-bridge", type, { campaignId });
    const responseType = eventType(status);
    post(responseEnvelope(request, responseType, status as unknown as Record<string, unknown>, { sequence: status.sequence }));
    return;
  }
  if (request.type === WEB_APP_MESSAGE_TYPES.statusRequest) {
    const status = await sendRuntimeRequest("web-app-bridge", INTERNAL_MESSAGE_TYPES.campaignStatus, { ...(campaignId ? { campaignId } : {}) });
    post(responseEnvelope(request, WEB_APP_MESSAGE_TYPES.status, (status ?? {}) as unknown as Record<string, unknown>, { sequence: status?.sequence }));
  }
}

function eventType(status: CampaignPublicStatus): WebAppEnvelope["type"] {
  if (status.status === "completed") return WEB_APP_MESSAGE_TYPES.completed;
  if (status.status === "stopped") return WEB_APP_MESSAGE_TYPES.cancelled;
  if (["paused", "pause_requested", "daily_limit_reached", "images_required"].includes(status.status)) return WEB_APP_MESSAGE_TYPES.paused;
  if (status.status === "error") return WEB_APP_MESSAGE_TYPES.error;
  if (status.status === "running") return WEB_APP_MESSAGE_TYPES.started;
  return WEB_APP_MESSAGE_TYPES.progress;
}

if (isAllowedWebAppOrigin(window.location.origin)) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const event = changes[CAMPAIGN_EVENT_KEY]?.newValue as CampaignPublicEvent | undefined;
    if (!event?.status || event.campaignId !== event.status.campaignId) return;
    post({
      channel: WEB_APP_CHANNEL,
      protocolVersion: PROTOCOL_VERSION,
      type: eventType(event.status),
      campaignId: event.campaignId,
      sequence: event.sequence,
      payload: event.status as unknown as Record<string, unknown>
    });
  });
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== window.location.origin || !isWebAppInboundEnvelope(event.data)) return;
    const request = event.data;
    void handleRequest(request).catch((error: unknown) => {
      const serialized = serializeError(error);
      logger.warn("web_app.request_rejected", { type: request.type, errorCode: serialized.code });
      if (request.type === WEB_APP_MESSAGE_TYPES.ping) {
        post(responseEnvelope(request, WEB_APP_MESSAGE_TYPES.status, {
          operational: false,
          message: serialized.message,
          extensionVersion: chrome.runtime.getManifest().version,
          configuredLimit: 0,
          sentToday: 0,
          availableToday: 0,
          errorCode: serialized.code
        }));
        return;
      }
      const campaignId = request.campaignId || (typeof request.payload.campaignId === "string" ? request.payload.campaignId : undefined);
      post({
        channel: WEB_APP_CHANNEL,
        protocolVersion: PROTOCOL_VERSION,
        type: WEB_APP_MESSAGE_TYPES.error,
        replyTo: request.requestId,
        ...(campaignId ? { campaignId, sequence: 1 } : {}),
        payload: serialized as unknown as Record<string, unknown>
      });
    });
  });
  logger.debug("web_app.bridge_ready", { origin: window.location.origin });
}
