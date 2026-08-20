import type { OutgoingMediaSnapshot } from "./selectors";

const PHOTO_EVIDENCE_SELECTOR = [
  "[data-testid='image-thumb']",
  "[data-testid='image-container']",
  "[data-testid='image-message']",
  "[data-testid*='image' i]",
  "[aria-label*='image' i]",
  "[aria-label*='imagen' i]",
  "[aria-label*='photo' i]",
  "[aria-label*='foto' i]",
  ".message-image",
  ".image-thumb",
  ".image-thumb-body"
].join(", ");

const STICKER_EVIDENCE_SELECTOR = [
  "[data-testid*='sticker' i]",
  "[data-icon*='sticker' i]",
  "[aria-label*='sticker' i]",
  "[aria-label*='pegatina' i]",
  "[aria-label*='figurinha' i]",
  "[title*='sticker' i]",
  ".sticker"
].join(", ");

const VIDEO_EVIDENCE_SELECTOR = [
  "video",
  "[data-testid*='video' i]",
  "[aria-label*='video' i]",
  "[title*='video' i]"
].join(", ");

const EMOJI_EVIDENCE_SELECTOR = [
  "img.emoji",
  "[data-emoji]",
  "[data-testid*='emoji' i]",
  "[aria-label*='emoji' i]"
].join(", ");

const TEXT_PAYLOAD_SELECTOR = "[data-testid='msg-text'], .selectable-text";
const OUTGOING_CANDIDATE_SELECTOR = "#main .message-out, #main [data-testid='msg-container'], #main [data-id]";

function messageBubble(candidate: HTMLElement): HTMLElement {
  if (candidate.classList.contains("message-out")) return candidate;
  const nestedOutgoing = candidate.querySelector<HTMLElement>(".message-out");
  if (nestedOutgoing) return nestedOutgoing;
  return candidate.closest<HTMLElement>(".message-out") ?? candidate;
}

function isOutgoingBubble(candidate: HTMLElement, bubble: HTMLElement): boolean {
  if (bubble.classList.contains("message-out") || Boolean(candidate.closest(".message-out"))) return true;
  const dataId = candidate.getAttribute("data-id") || bubble.getAttribute("data-id") || "";
  return dataId.startsWith("true_");
}

function stableMessageIdentity(candidate: HTMLElement, bubble: HTMLElement): string {
  // WhatsApp 2.3000.x can expose opaque/hex message data-id values instead of
  // the historical true_/false_ serialized form. Direction is proven by the
  // .message-out bubble; therefore any non-empty data-id on that message or an
  // ancestor is a valid stable identity for at-most-once reconciliation.
  const dataIdContainer = (bubble.matches("[data-id]") ? bubble : bubble.closest<HTMLElement>("[data-id]"))
    ?? (candidate.matches("[data-id]") ? candidate : candidate.closest<HTMLElement>("[data-id]"));
  return dataIdContainer?.getAttribute("data-id") || bubble.id || dataIdContainer?.id || "";
}

function hasGenericPhotoImage(element: HTMLElement): boolean {
  const images = [...element.querySelectorAll<HTMLImageElement>("img[src]")];
  return images.some((image) => !image.closest(STICKER_EVIDENCE_SELECTOR) && !image.matches(EMOJI_EVIDENCE_SELECTOR));
}

export function hasExplicitOutgoingPhotoEvidence(element: HTMLElement): boolean {
  const sticker = element.matches(STICKER_EVIDENCE_SELECTOR) || Boolean(element.querySelector(STICKER_EVIDENCE_SELECTOR));
  if (sticker) return false;

  const video = element.matches(VIDEO_EVIDENCE_SELECTOR) || Boolean(element.querySelector(VIDEO_EVIDENCE_SELECTOR));
  if (video) return false;

  const explicitPhoto = element.matches(PHOTO_EVIDENCE_SELECTOR) || Boolean(element.querySelector(PHOTO_EVIDENCE_SELECTOR));
  if (explicitPhoto) return true;

  // Current WhatsApp builds may render a sent photo as a plain <img> inside the
  // outgoing bubble without the historical image-thumb test id. For campaign
  // image steps we send no caption inside the media bubble, so a generic image
  // without a text payload is strong DOM evidence of a photo, while emoji-only
  // text messages remain excluded.
  const hasTextPayload = Boolean(element.querySelector(TEXT_PAYLOAD_SELECTOR));
  return !hasTextPayload && hasGenericPhotoImage(element);
}

export function outgoingPhotoMessages(root: ParentNode = document): OutgoingMediaSnapshot[] {
  const candidates = root.querySelectorAll<HTMLElement>(OUTGOING_CANDIDATE_SELECTOR);
  const seen = new Set<HTMLElement>();
  const result: OutgoingMediaSnapshot[] = [];

  for (const candidate of candidates) {
    const bubble = messageBubble(candidate);
    if (!isOutgoingBubble(candidate, bubble) || seen.has(bubble) || !hasExplicitOutgoingPhotoEvidence(bubble)) continue;
    seen.add(bubble);
    const identity = stableMessageIdentity(candidate, bubble);
    result.push({
      identity: identity || `observation-outgoing-photo-${result.length}`,
      stableIdentity: Boolean(identity),
      element: bubble
    });
  }

  return result;
}
