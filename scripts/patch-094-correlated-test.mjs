import { readFile, writeFile } from "node:fs/promises";

async function replaceOnce(path, from, to) {
  let source = await readFile(path, "utf8");
  if (source.includes(to)) return false;
  if (!source.includes(from)) throw new Error(`Expected source not found in ${path}`);
  source = source.replace(from, to);
  await writeFile(path, source);
  return true;
}

const serviceChanged = await replaceOnce(
  "src/background/service-worker.ts",
  `    await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, { operationId, phoneDigits: phone.digits }, tab.id);\n    await stateStore.patch({\n      currentStep: "wait-conversation",\n      lastCheckpoint: { operationId, recipientId: operationId, step: "navigation-requested", createdAt: new Date().toISOString() }\n    });\n    await whatsappTransport.waitForContent(tab.id, 30_000);\n    await stateStore.patch({ currentStep: "send-text", statusMessage: "Enviando y verificando el mensaje de prueba…" });`,
  `    const navigationRequestId = createId("navigation");\n    const navigation = await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappOpenConversation, {\n      operationId,\n      phoneDigits: phone.digits,\n      navigationRequestId\n    }, tab.id);\n    await stateStore.patch({\n      currentStep: "wait-conversation",\n      lastCheckpoint: { operationId, recipientId: operationId, step: "navigation-requested", createdAt: new Date().toISOString() }\n    });\n    const readiness = await whatsappTransport.waitForContent(tab.id, 30_000, undefined, {\n      previousContentInstanceId: navigation.contentInstanceId,\n      purpose: "content_handshake"\n    });\n    const navigationObservedAt = new Date().toISOString();\n    await whatsappTransport.send(INTERNAL_MESSAGE_TYPES.whatsappProveConversation, {\n      operationId: \`prove:\${operationId}\`,\n      phoneDigits: phone.digits,\n      navigationRequestId,\n      timeoutMs: 4_000,\n      requestedNavigationAt: navigation.requestedNavigationAt,\n      navigationObservedAt,\n      ...(readiness.contentInstanceId ? { expectedContentInstanceId: readiness.contentInstanceId } : {})\n    }, tab.id);\n    await stateStore.patch({ currentStep: "send-text", statusMessage: "Enviando y verificando el mensaje de prueba…" });`
);

const testsChanged = await replaceOnce(
  "tests/contact-engine.test.ts",
  `  it("can resume after the conversation-opening retry window is exhausted", async () => {\n    const store = new MemoryCheckpointStore();\n    const adapter = new FakeAdapter();\n    adapter.remainingOpenFailures = 3;\n    const paused = await run(checkpoint(0), adapter, store);\n\n    expect(paused.status).toBe("paused");\n    expect(paused.pauseReason).toBe("open_conversation_failed");\n    expect(paused.steps[0]?.attempts).toBe(0);\n\n    const resumed = await run(paused, adapter, store);\n    expect(resumed.status).toBe("completed");\n    expect(resumed.openConversationAttempts).toBe(4);\n    expect(adapter.calls.filter((call) => call === "text")).toHaveLength(1);\n  });`,
  `  it("does not create a new open-conversation budget after Resume", async () => {\n    const store = new MemoryCheckpointStore();\n    const adapter = new FakeAdapter();\n    adapter.remainingOpenFailures = 10;\n    const paused = await run(checkpoint(0), adapter, store);\n\n    expect(paused.status).toBe("paused");\n    expect(paused.pauseReason).toBe("open_conversation_failed");\n    expect(paused.openConversationAttempts).toBe(2);\n    expect(paused.steps[0]?.attempts).toBe(0);\n\n    const resumed = await run(paused, adapter, store);\n    expect(resumed.status).toBe("paused");\n    expect(resumed.openConversationAttempts).toBe(2);\n    expect(adapter.calls.filter((call) => call === "open")).toHaveLength(2);\n    expect(adapter.calls.filter((call) => call === "text")).toHaveLength(0);\n  });`
);

const leaseChanged = await replaceOnce(
  "src/whatsapp/conversation-context.ts",
  `export function proveConversationContext(\n  expectedPhoneDigits: string,\n  root: ParentNode = document,\n  context?: CausalNavigationContext\n): ConversationContextProof | null {\n  return inspectInitialProof(expectedPhoneDigits, root, context).proof ?? validateActiveLease(expectedPhoneDigits, root);\n}`,
  `export function proveConversationContext(\n  expectedPhoneDigits: string,\n  root: ParentNode = document,\n  context?: CausalNavigationContext\n): ConversationContextProof | null {\n  // Una vez que una navegación estableció una lease, la revalidación previa al Send\n  // debe respetar su guard. No se rescata una selección manual con una URL vieja.\n  if (!context && activeLease?.expectedPhoneDigits === expectedPhoneDigits) {\n    return validateActiveLease(expectedPhoneDigits, root);\n  }\n  if (context && activeLease?.navigationRequestId !== context.navigationRequestId) activeLease = null;\n  return inspectInitialProof(expectedPhoneDigits, root, context).proof ?? validateActiveLease(expectedPhoneDigits, root);\n}`
);

console.log(JSON.stringify({ serviceChanged, testsChanged, leaseChanged }));
