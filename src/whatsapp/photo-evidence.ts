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
const MESSAGE_CANDIDATE_SELECTOR = ".message-out, [data-testid='msg-container'], [data-id]";
const OUTGOING_CANDIDATE_SELECTOR = "#main .message-out, #main [data-testid='msg-container'], #main [data-id]";
const OUTGOING_ACK_SELECTOR = "[data-icon='msg-check'], [data-icon='msg-dblcheck']";
const OUTGOING_SELF_LABEL_SELECTOR = [
  "[aria-label='You:']",
  "[aria-label='Tú:']",
  "[aria-label='Vos:']",
  "[aria-label='Você:']"
].join(", ");

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
    baselineCandidateCount: number;
    mutationCount: number;
    candidateMutationCount: number;
  };
  stop: () => void;
}

function messageBubble(candidate: HTMLElement): HTMLElement {
  if (candidate.classList.contains("message-out")) return candidate;
  const nestedOutgoing = candidate.querySelector<HTMLElement>(".message-out");
  if (nestedOutgoing) return nestedOutgoing;
  return candidate.closest<HTMLElement>(".message-out") ?? candidate;
}

function hasOutgoingSemanticEvidence(element: HTMLElement): boolean {
  return Boolean(element.querySelector(OUTGOING_ACK_SELECTOR))
    || Boolean(element.querySelector(OUTGOING_SELF_LABEL_SELECTOR));
}

function isOutgoingBubble(candidate: HTMLElement, bubble: HTMLElement): boolean {
  if (bubble.classList.contains("message-out") || Boolean(candidate.closest(".message-out"))) return true;
  const dataId = candidate.getAttribute("data-id") || bubble.getAttribute("data-id") || "";
  if (dataId.startsWith("true_")) return true;
  return hasOutgoingSemanticEvidence(bubble) || hasOutgoingSemanticEvidence(candidate);
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
  if (root instanceof HTMLElement && root.matches(MESSAGE_CANDIDATE_SELECTOR)) result.push(root);
  if ("querySelectorAll" in root) {
    result.push(...root.querySelectorAll<HTMLElement>(MESSAGE_CANDIDATE_SELECTOR));
  }
  return [...new Set(result)];
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

function messageCandidatesFromNode(node: Node): HTMLElement[] {
  if (!(node instanceof HTMLElement)) return [];
  const candidates: HTMLElement[] = [];
  const add = (candidate: HTMLElement | null): void => {
    if (!candidate || candidates.includes(candidate)) return;
    candidates.push(candidate);
  };

  if (node.matches(MESSAGE_CANDIDATE_SELECTOR)) add(node);
  add(node.closest<HTMLElement>(MESSAGE_CANDIDATE_SELECTOR));
  for (const candidate of node.querySelectorAll<HTMLElement>(MESSAGE_CANDIDATE_SELECTOR)) add(candidate);
  return candidates;
}

function nearestMessageCandidate(node: Node): HTMLElement | null {
  if (!(node instanceof HTMLElement)) return null;
  if (node.matches(MESSAGE_CANDIDATE_SELECTOR)) return node;
  return node.closest<HTMLElement>(MESSAGE_CANDIDATE_SELECTOR);
}

export function startCausalOutgoingPhotoObserver(root: HTMLElement): CausalOutgoingPhotoObserver {
  const baselineCandidates = new Set(candidateElements(root));
  const baselineStableIds = new Set(
    outgoingPhotoMessages(root)
      .filter((item) => item.stableIdentity)
      .map((item) => item.identity)
  );
  const trackedNewCandidates = new Set<HTMLElement>();
  let observation: CausalOutgoingPhotoObservation | null = null;
  let mutationCount = 0;
  let candidateMutationCount = 0;

  const inspectCandidate = (candidate: HTMLElement): void => {
    if (observation) return;
    const snapshot = snapshotFromCandidate(candidate);
    if (!snapshot) return;

    const stableIdentityIsNew = snapshot.stableIdentity && !baselineStableIds.has(snapshot.identity);
    const structurallyNew = trackedNewCandidates.has(candidate) || !baselineCandidates.has(candidate);
    if (!stableIdentityIsNew && !structurallyNew) return;

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
    mutationCount += mutations.length;
    for (const mutation of mutations) {
      const relatedCandidates = new Set<HTMLElement>();

      for (const node of mutation.addedNodes) {
        for (const candidate of messageCandidatesFromNode(node)) {
          relatedCandidates.add(candidate);
          if (!baselineCandidates.has(candidate)) trackedNewCandidates.add(candidate);
        }
      }

      const targetCandidate = nearestMessageCandidate(mutation.target);
      if (targetCandidate) relatedCandidates.add(targetCandidate);

      if (relatedCandidates.size > 0) candidateMutationCount += 1;
      for (const candidate of relatedCandidates) inspectCandidate(candidate);
    }
  });

  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "style", "data-testid", "data-icon", "aria-label", "data-id", "class"]
  });

  return {
    take: () => observation,
    summary: () => ({
      newOutgoingBubbleCount: trackedNewCandidates.size,
      photoObserved: Boolean(observation),
      stableIdObserved: Boolean(observation?.snapshot.stableIdentity),
      evidenceMethod: observation?.method ?? null,
      baselineCandidateCount: baselineCandidates.size,
      mutationCount,
      candidateMutationCount
    }),
    stop: () => observer.disconnect()
  };
}
