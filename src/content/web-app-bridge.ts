import { isAllowedWebAppOrigin } from "../config/origins";
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
import type { SerializedCampaignPayload } from "../shared/serialization";
import {
  CAMPAIGN_EVENT_KEY,
  type CampaignPublicEvent,
  type CampaignPublicEventType
} from "../campaign/events";
import type { CampaignPublicStatus } from "../campaign/campaign-types";
import {
  captureBridgeRuntimeMetadata,
  installBridgeInstanceGuard,
  invalidatedContextMessage,
  isExtensionContextInvalidated,
  isRuntimeAvailable
} from "./bridge-runtime";

const lastPostedSequenceByCampaign = new Map<string, number>();
const BRIDGE_RUNTIME = captureBridgeRuntimeMetadata();
const BRIDGE_INSTANCE = installBridgeInstanceGuard();
let bridgeActive = true;
let invalidationPosted = false;
let releaseSupersededListener: () => void = () => undefined;

function bridgeMetadata(): Record<string, unknown> {
  return {
    bridgeInstanceId: BRIDGE_INSTANCE.instanceId,
    bridgeGeneration: BRIDGE_INSTANCE.generation,
    bridgeCreatedAt: BRIDGE_INSTANCE.createdAt,
    runtimeAvailable: bridgeActive && BRIDGE_INSTANCE.isCurrent() && isRuntimeAvailable()
  };
}

function post(message: WebAppEnvelope): void {
  window.postMessage(message, window.location.origin);
}

function responseEnvelope(
  request: WebAppEnvelope,
  type: WebAppEnvelope["type"],
  payload: Record<string, unknown>,
  extra: Pick<WebAppEnvelope, "campaignId" | "sequence"> = {}
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

function statusPayload(status: Record<string, unknown>): Record<string, unknown> {
  return { ...status, ...bridgeMetadata() };
}

function messageTypeForEvent(type: CampaignPublicEventType): WebAppEnvelope["type"] {
  return {
    CAMPAIGN_ACCEPTED: WEB_APP_MESSAGE_TYPES.accepted,
    CAMPAIGN_STARTED: WEB_APP_MESSAGE_TYPES.started,
    CAMPAIGN_PROGRESS: WEB_APP_MESSAGE_TYPES.progress,
    CAMPAIGN_PAUSED: WEB_APP_MESSAGE_TYPES.paused,
    CAMPAIGN_RESUMED: WEB_APP_MESSAGE_TYPES.resumed,
    CAMPAIGN_ERROR: WEB_APP_MESSAGE_TYPES.error,
    CAMPAIGN_STOPPED: WEB_APP_MESSAGE_TYPES.stopped,
    CAMPAIGN_COMPLETED: WEB_APP_MESSAGE_TYPES.completed
  }[type];
}

function messageTypeForStatus(
  status: CampaignPublicStatus,
  requestedType?: WebAppEnvelope["type"]
): WebAppEnvelope["type"] {
  if (status.status === "completed") return WEB_APP_MESSAGE_TYPES.completed;
  if (status.status === "stopped") return WEB_APP_MESSAGE_TYPES.stopped;
  if (status.status === "error") return WEB_APP_MESSAGE_TYPES.error;
  if (["paused", "pause_requested", "daily_limit_reached", "images_required"].includes(status.status)) {
    return WEB_APP_MESSAGE_TYPES.paused;
  }
  if (requestedType === WEB_APP_MESSAGE_TYPES.resumeRequest || requestedType === WEB_APP_MESSAGE_TYPES.retryRequest) {
    return WEB_APP_MESSAGE_TYPES.resumed;
  }
  if (requestedType === WEB_APP_MESSAGE_TYPES.startRequest || requestedType === WEB_APP_MESSAGE_TYPES.retryFailedRequest) {
    return WEB_APP_MESSAGE_TYPES.started;
  }
  return WEB_APP_MESSAGE_TYPES.progress;
}

function campaignIdOf(request: WebAppEnvelope): string {
  return request.campaignId || (typeof request.payload.campaignId === "string" ? request.payload.campaignId : "");
}

function requireCurrentRuntime(): void {
  if (!bridgeActive || !BRIDGE_INSTANCE.isCurrent() || !isRuntimeAvailable()) {
    throw new Error("Extension context invalidated.");
  }
}

async function handleRequest(request: WebAppEnvelope): Promise<void> {
  requireCurrentRuntime();
  if (request.type === WEB_APP_MESSAGE_TYPES.ping) {
    const status = await sendRuntimeRequest("web-app-bridge", INTERNAL_MESSAGE_TYPES.webAppPing, {});
    post(responseEnvelope(request, WEB_APP_MESSAGE_TYPES.status, statusPayload(status as unknown as Record<string, unknown>)));
    return;
  }
  if (request.type === WEB_APP_MESSAGE_TYPES.preflightRequest) {
    await sendRuntimeRequest("web-app-bridge", INTERNAL_MESSAGE_TYPES.runPreflight, { developmentFault: "none" });
    const status = await sendRuntimeRequest("web-app-bridge", INTERNAL_MESSAGE_TYPES.webAppPing, {});
    post(responseEnvelope(request, WEB_APP_MESSAGE_TYPES.status, statusPayload(status as unknown as Record<string, unknown>)));
    return;
  }
  if (request.type === WEB_APP_MESSAGE_TYPES.prepare) {
    const accepted = await sendRuntimeRequest(
      "web-app-bridge",
      INTERNAL_MESSAGE_TYPES.webAppPrepareCampaign,
      request.payload as unknown as SerializedCampaignPayload,
      request.requestId
    );
    post(responseEnvelope(request, WEB_APP_MESSAGE_TYPES.accepted, accepted as unknown as Record<string, unknown>, {
      campaignId: accepted.campaignId,
      sequence: accepted.sequence
    }));
    return;
  }

  const campaignId = campaignIdOf(request);
  const controls = {
    [WEB_APP_MESSAGE_TYPES.cancelRequest]: INTERNAL_MESSAGE_TYPES.campaignStop,
    [WEB_APP_MESSAGE_TYPES.startRequest]: INTERNAL_MESSAGE_TYPES.campaignStart,
    [WEB_APP_MESSAGE_TYPES.pauseRequest]: INTERNAL_MESSAGE_TYPES.campaignPause,
    [WEB_APP_MESSAGE_TYPES.resumeRequest]: INTERNAL_MESSAGE_TYPES.campaignResume,
    [WEB_APP_MESSAGE_TYPES.retryRequest]: INTERNAL_MESSAGE_TYPES.campaignResume,
    [WEB_APP_MESSAGE_TYPES.retryFailedRequest]: INTERNAL_MESSAGE_TYPES.campaignResume,
    [WEB_APP_MESSAGE_TYPES.stopRequest]: INTERNAL_MESSAGE_TYPES.campaignStop,
    [WEB_APP_MESSAGE_TYPES.deleteRequest]: INTERNAL_MESSAGE_TYPES.campaignStop
  } as const;
  if (request.type in controls) {
    const type = controls[request.type as keyof typeof controls];
    const status = await sendRuntimeRequest(
      "web-app-bridge",
      type,
      { campaignId, ...(request.sequence === undefined ? {} : { expectedSequence: request.sequence }) },
      request.requestId
    );
    post(responseEnvelope(
      request,
      messageTypeForStatus(status, request.type),
      status as unknown as Record<string, unknown>,
      { campaignId: status.campaignId, sequence: status.sequence }
    ));
    return;
  }
  if (request.type === WEB_APP_MESSAGE_TYPES.statusRequest) {
    const campaign = await sendRuntimeRequest(
      "web-app-bridge",
      INTERNAL_MESSAGE_TYPES.campaignStatus,
      { ...(campaignId ? { campaignId } : {}) }
    );
    const extensionStatus = await sendRuntimeRequest("web-app-bridge", INTERNAL_MESSAGE_TYPES.webAppPing, {});
    post(responseEnvelope(
      request,
      WEB_APP_MESSAGE_TYPES.status,
      statusPayload({ ...extensionStatus, campaign } as unknown as Record<string, unknown>),
      campaign ? { campaignId: campaign.campaignId, sequence: campaign.sequence } : {}
    ));
  }
}

function bridgeFailure(error: unknown): {
  code: string;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
  stack?: string;
} {
  if (isExtensionContextInvalidated(error)) {
    return {
      code: "EXTENSION_CONTEXT_INVALIDATED",
      message: invalidatedContextMessage(),
      recoverable: true
    };
  }
  return serializeError(error);
}

function retireBridge(): void {
  if (!bridgeActive) return;
  bridgeActive = false;
  window.removeEventListener("message", onWindowMessage);
  releaseSupersededListener();
  BRIDGE_INSTANCE.release();
  try {
    chrome.storage.onChanged.removeListener(onStorageChanged);
  } catch {
    // Un content script cuyo runtime fue invalidado no vuelve a tocar chrome.*.
  }
}

function onStorageChanged(changes: { [key: string]: chrome.storage.StorageChange }, areaName: string): void {
  if (!bridgeActive || !BRIDGE_INSTANCE.isCurrent()) {
    retireBridge();
    return;
  }
  if (areaName !== "local") return;
  const event = changes[CAMPAIGN_EVENT_KEY]?.newValue as CampaignPublicEvent | undefined;
  if (!event || event.eventSchemaVersion !== 1 || event.campaignId !== event.payload.campaignId) return;
  const lastSequence = lastPostedSequenceByCampaign.get(event.campaignId) ?? -1;
  if (event.sequence <= lastSequence) return;
  lastPostedSequenceByCampaign.set(event.campaignId, event.sequence);
  post({
    channel: WEB_APP_CHANNEL,
    protocolVersion: PROTOCOL_VERSION,
    type: messageTypeForEvent(event.type),
    campaignId: event.campaignId,
    sequence: event.sequence,
    payload: event.payload as unknown as Record<string, unknown>
  });
}

function postInvalidatedStatusOnce(request: WebAppEnvelope, failure: ReturnType<typeof bridgeFailure>): void {
  if (invalidationPosted) return;
  invalidationPosted = true;
  post(responseEnvelope(request, WEB_APP_MESSAGE_TYPES.status, {
    operational: false,
    message: failure.message,
    extensionVersion: BRIDGE_RUNTIME.extensionVersion,
    manifestVersion: BRIDGE_RUNTIME.manifestVersion,
    protocolVersion: PROTOCOL_VERSION,
    configuredLimit: 0,
    sentToday: 0,
    availableToday: 0,
    overallStatus: "RED",
    campaign: null,
    updatedAt: new Date().toISOString(),
    errorCode: failure.code,
    bridgeInstanceId: BRIDGE_INSTANCE.instanceId,
    bridgeGeneration: BRIDGE_INSTANCE.generation,
    bridgeCreatedAt: BRIDGE_INSTANCE.createdAt,
    runtimeAvailable: false
  }));
}

function onWindowMessage(event: MessageEvent<unknown>): void {
  if (!bridgeActive || !BRIDGE_INSTANCE.isCurrent()) {
    retireBridge();
    return;
  }
  if (event.source !== window || event.origin !== window.location.origin || !isWebAppInboundEnvelope(event.data)) return;
  const request = event.data;
  void handleRequest(request).catch((error: unknown) => {
    const failure = bridgeFailure(error);
    if (failure.code === "EXTENSION_CONTEXT_INVALIDATED") {
      logger.warn("web_app.bridge_invalidated", {
        bridgeGeneration: BRIDGE_INSTANCE.generation,
        extensionVersion: BRIDGE_RUNTIME.extensionVersion
      });
      postInvalidatedStatusOnce(request, failure);
      retireBridge();
      return;
    }
    logger.warn("web_app.request_rejected", { type: request.type, errorCode: failure.code });
    if (request.type === WEB_APP_MESSAGE_TYPES.ping || request.type === WEB_APP_MESSAGE_TYPES.preflightRequest) {
      post(responseEnvelope(request, WEB_APP_MESSAGE_TYPES.status, {
        operational: false,
        message: failure.message,
        extensionVersion: BRIDGE_RUNTIME.extensionVersion,
        manifestVersion: BRIDGE_RUNTIME.manifestVersion,
        protocolVersion: PROTOCOL_VERSION,
        configuredLimit: 0,
        sentToday: 0,
        availableToday: 0,
        overallStatus: "RED",
        campaign: null,
        updatedAt: new Date().toISOString(),
        errorCode: failure.code,
        ...bridgeMetadata()
      }));
    } else {
      const campaignId = campaignIdOf(request);
      post({
        channel: WEB_APP_CHANNEL,
        protocolVersion: PROTOCOL_VERSION,
        type: WEB_APP_MESSAGE_TYPES.error,
        replyTo: request.requestId,
        ...(campaignId ? { campaignId } : {}),
        payload: failure as unknown as Record<string, unknown>
      });
    }
  });
}

if (isAllowedWebAppOrigin(window.location.origin)) {
  releaseSupersededListener = BRIDGE_INSTANCE.onSuperseded(retireBridge);
  chrome.storage.onChanged.addListener(onStorageChanged);
  window.addEventListener("message", onWindowMessage);
  logger.debug("web_app.bridge_ready", {
    origin: window.location.origin,
    extensionVersion: BRIDGE_RUNTIME.extensionVersion,
    bridgeInstanceId: BRIDGE_INSTANCE.instanceId,
    bridgeGeneration: BRIDGE_INSTANCE.generation,
    bridgeCreatedAt: BRIDGE_INSTANCE.createdAt,
    runtimeAvailable: BRIDGE_RUNTIME.runtimeAvailable
  });
} else {
  retireBridge();
}
