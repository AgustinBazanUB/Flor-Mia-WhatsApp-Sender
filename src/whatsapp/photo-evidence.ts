import { outgoingMediaMessages, type OutgoingMediaSnapshot } from "./selectors";

const PHOTO_EVIDENCE_SELECTOR = [
  "[data-testid='image-thumb']",
  "[data-testid='image-container']",
  "[data-testid='image-message']",
  ".message-image",
  ".image-thumb",
  ".image-thumb-body"
].join(", ");

const STICKER_EVIDENCE_SELECTOR = [
  "[data-testid*='sticker' i]",
  "[data-icon*='sticker' i]",
  "[aria-label*='sticker' i]",
  "[title*='sticker' i]",
  ".sticker"
].join(", ");

export function hasExplicitOutgoingPhotoEvidence(element: HTMLElement): boolean {
  const photo = element.matches(PHOTO_EVIDENCE_SELECTOR) || Boolean(element.querySelector(PHOTO_EVIDENCE_SELECTOR));
  if (!photo) return false;
  const sticker = element.matches(STICKER_EVIDENCE_SELECTOR) || Boolean(element.querySelector(STICKER_EVIDENCE_SELECTOR));
  return !sticker;
}

export function outgoingPhotoMessages(root: ParentNode = document): OutgoingMediaSnapshot[] {
  return outgoingMediaMessages(root).filter((item) => hasExplicitOutgoingPhotoEvidence(item.element));
}
