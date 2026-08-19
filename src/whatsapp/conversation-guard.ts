export interface ConversationGuardSnapshot {
  trustedNavigationEpoch: number;
  createdAt: string;
}

let installed = false;
let trustedNavigationEpoch = 0;
const createdAt = new Date().toISOString();

function outsideActiveConversation(target: EventTarget | null, root: Document): boolean {
  if (!(target instanceof Element)) return true;
  const main = root.querySelector("#main");
  return !main || !main.contains(target);
}

export function notePotentialManualConversationNavigation(): void {
  trustedNavigationEpoch += 1;
}

export function installConversationInteractionGuard(root: Document = document): () => void {
  if (installed) return () => undefined;
  installed = true;

  const onPointer = (event: Event): void => {
    if (!event.isTrusted || !outsideActiveConversation(event.target, root)) return;
    notePotentialManualConversationNavigation();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (!event.isTrusted || !outsideActiveConversation(event.target, root)) return;
    if (["Enter", " ", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
      notePotentialManualConversationNavigation();
    }
  };

  root.addEventListener("pointerdown", onPointer, true);
  root.addEventListener("click", onPointer, true);
  root.addEventListener("keydown", onKey, true);

  return () => {
    root.removeEventListener("pointerdown", onPointer, true);
    root.removeEventListener("click", onPointer, true);
    root.removeEventListener("keydown", onKey, true);
    installed = false;
  };
}

export function conversationGuardSnapshot(): ConversationGuardSnapshot {
  return { trustedNavigationEpoch, createdAt };
}
