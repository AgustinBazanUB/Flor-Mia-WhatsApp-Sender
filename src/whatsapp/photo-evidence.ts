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

export type PhotoEvidenceMethod =
  | "stable-outgoing-photo-dom"
  | "causal-outgoing-photo-mutation";

export interface CausalOutgoingPhotoObservation {
  snapshot: OutgoingMediaSnapshot;
  method: PhotoEvidenceMethod;
  observedAt: string;
}

export interface CausalOutgoingPhotoObserver {
  take: () => CausalOutgoingPhotoObservation | null;
  summary: () => {
    newOutgoingBubbleCount: number;
    photoObserved: boolean;
    stableIdObserved: boolean;
    evidenceMethod: PhotoEvidenceMethod | null;
  };
  stop: () => void;
}

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
  const dataIdContainer = (bubble.matches("[data-id]") ? bubble : bubble.closest<HTMLElement>("[data-id]"))
    ?? (candidate.matches("[data-id]") ? candidate : candidate.closest<HTMLElement>("[data-id]"));
  return dataIdContainer?.getAttribute("data-id") || bubble.id || dataIdContainer?.id || "";
}

function hasGenericPhotoImage(element: HTMLElement): boolean {
  const images = [...element.querySelectorAll<HTMLImageElement>("img[src]")];
  if (images.some((image) => !image.closest(STICKER_EVIDENCE_SELECTOR) && !image.matches(EMOJI_EVIDENCE_SELECTOR))) {
    return true;
  }
  if (element.querySelector("canvas, picture source[srcset]")) return true;
  const styled = [element, ...element.querySelectorAll<HTMLElement>("[style]")];
  return styled.some((candidate) => /background-image\s*:\s*(?:url|image-set)\(/i.test(candidate.getAttribute("style") || ""));
}

export function hasExplicitOutgoingPhotoEvidence(element: HTMLElement): boolean {
  const sticker = element.matches(STICKER_EVIDENCE_SELECTOR) || Boolean(element.querySelector(STICKER_EVIDENCE_SELECTOR));
  if (sticker) return false;

  const video = element.matches(VIDEO_EVIDENCE_SELECTOR) || Boolean(element.querySelector(VIDEO_EVIDENCE_SELECTOR));
  if (video) return false;

  const explicitPhoto = element.matches(PHOTO_EVIDENCE_SELECTOR) || Boolean(element.querySelector(PHOTO_EVIDENCE_SELECTOR));
  if (explicitPhoto) return true;

  const hasTextPayload = Boolean(element.querySelector(TEXT_PAYLOAD_SELECTOR));
  return !hasTextPayload && hasGenericPhotoImage(element);
}

function snapshotFromCandidate(candidate: HTMLElement): OutgoingMediaSnapshot | null {
  const bubble = messageBubble(candidate);
  if (!isOutgoingBubble(candidate, bubble) || !hasExplicitOutgoingPhotoEvidence(bubble)) return null;
  const identity = stableMessageIdentity(candidate, bubble);
  return {
    identity: identity || "",
    stableIdentity: Boolean(identity),
    element: bubble
  };
}

function candidateElements(root: ParentNode): HTMLElement[] {
  const result: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(".message-out, [data-testid='msg-container'], [data-id]")) result.push(root);
  if ("querySelectorAll" in root) {
    result.push(...root.querySelectorAll<HTMLElement>(".message-out, [data-testid='msg-container'], [data-id]"));
  }
  return result;
}

export function outgoingPhotoMessages(root: ParentNode = document): OutgoingMediaSnapshot[] {
  const candidates = root === document
    ? [...document.querySelectorAll<HTMLElement>(OUTGOING_CANDIDATE_SELECTOR)]
    : candidateElements(root);
  const seen = new Set<HTMLElement>();
  const result: OutgoingMediaSnapshot[] = [];

  for (const candidate of candidates) {
    const snapshot = snapshotFromCandidate(candidate);
    if (!snapshot || seen.has(snapshot.element)) continue;
    seen.add(snapshot.element);
    result.push({
      ...snapshot,
      identity: snapshot.identity || `observation-outgoing-photo-${result.length}`
    });
  }

  return result;
}

function outgoingBubblesFromAddedNode(node: Node): HTMLElement[] {
  if (!(node instanceof HTMLElement)) return [];
  const bubbles: HTMLElement[] = [];
  const add = (candidate: HTMLElement | null): void => {
    if (!candidate || bubbles.includes(candidate)) return;
    if (candidate.classList.contains("message-out")) bubbles.push(candidate);
    const nested = candidate.querySelectorAll<HTMLElement>(".message-out");
    for (const bubble of nested) if (!bubbles.includes(bubble)) bubbles.push(bubble);
  };
  add(node);
  add(node.closest<HTMLElement>(".message-out"));
  return bubbles;
}

export function startCausalOutgoingPhotoObserver(root: HTMLElement): CausalOutgoingPhotoObserver {
  const baselineBubbles = new Set(root.querySelectorAll<HTMLElement>(".message-out"));
  const trackedNewBubbles = new Set<HTMLElement>();
  let observation: CausalOutgoingPhotoObservation | null = null;

  const inspectBubble = (bubble: HTMLElement): void => {
    if (observation || baselineBubbles.has(bubble) || !trackedNewBubbles.has(bubble)) return;
    const snapshot = snapshotFromCandidate(bubble);
    if (!snapshot) return;
    observation = {
      snapshot: {
        ...snapshot,
        identity: snapshot.identity || `causal-photo-${Date.now().toString(36)}`
      },
      method: "causal-outgoing-photo-mutation",
      observedAt: new Date().toISOString()
    };
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        for (const bubble of outgoingBubblesFromAddedNode(node)) {
          if (!baselineBubbles.has(bubble)) trackedNewBubbles.add(bubble);
          inspectBubble(bubble);
        }
      }

      const target = mutation.target;
      if (target instanceof HTMLElement) {
        const bubble = target.classList.contains("message-out") ? target : target.closest<HTMLElement>(".message-out");
        if (bubble && trackedNewBubbles.has(bubble)) inspectBubble(bubble);
      }
    }
  });

  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "style", "data-testid", "aria-label", "data-id", "class"]
  });

  return {
    take: () => observation,
    summary: () => ({
      newOutgoingBubbleCount: trackedNewBubbles.size,
      photoObserved: Boolean(observation),
      stableIdObserved: Boolean(observation?.snapshot.stableIdentity),
      evidenceMethod: observation?.method ?? null
    }),
    stop: () => observer.disconnect()
  };
}
