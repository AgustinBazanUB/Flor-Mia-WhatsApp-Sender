import { readFile, writeFile } from "node:fs/promises";

const path = "tests/contact-adapter-binding.test.ts";
let source = await readFile(path, "utf8");

source = source.replace(
  `function navigation(contentInstanceId = "content-old") {\n  return { navigationStarted: true as const, requestedNavigationAt: NOW, contentInstanceId };\n}`,
  `function navigation(contentInstanceId = "content-old", navigationRequestId = "navigation-test") {\n  return { navigationStarted: true as const, requestedNavigationAt: NOW, contentInstanceId, navigationRequestId };\n}`
);

source = source.replaceAll(
  `if (type === "WA_OPEN_CONVERSATION") return navigation();`,
  `if (type === "WA_OPEN_CONVERSATION") {\n          const navigationRequestId = (payload as { navigationRequestId: string }).navigationRequestId;\n          return navigation("content-old", navigationRequestId);\n        }`
);
source = source.replaceAll(
  `if (type === "WA_OPEN_CONVERSATION") return navigation("content-old");`,
  `if (type === "WA_OPEN_CONVERSATION") {\n          const navigationRequestId = (payload as { navigationRequestId: string }).navigationRequestId;\n          return navigation("content-old", navigationRequestId);\n        }`
);
source = source.replaceAll(
  `if (type === "WA_OPEN_CONVERSATION") { navigations += 1; return navigation("content-old"); }`,
  `if (type === "WA_OPEN_CONVERSATION") {\n          navigations += 1;\n          const navigationRequestId = (payload as { navigationRequestId: string }).navigationRequestId;\n          return navigation("content-old", navigationRequestId);\n        }`
);
source = source.replace(
  `send: async (type: InternalMessageType) => type === "WA_OPEN_CONVERSATION"\n        ? navigation()\n        : { verified: true, evidence: "header-recipient-id", checkedAt: NOW }`,
  `send: async (type: InternalMessageType, payload: unknown) => type === "WA_OPEN_CONVERSATION"\n        ? navigation("content-old", (payload as { navigationRequestId: string }).navigationRequestId)\n        : { verified: true, proofLevel: "strong", evidence: "header-recipient-id", checkedAt: NOW }`
);
source = source.replace(
  `send: async () => navigation()`,
  `send: async (_type: InternalMessageType, payload: unknown) => navigation("content-old", (payload as { navigationRequestId: string }).navigationRequestId)`
);

// Give every send mock a named payload parameter when the codemod above now references it.
source = source.replaceAll(
  `send: async (type: InternalMessageType, _payload: unknown, tabId?: number) => {`,
  `send: async (type: InternalMessageType, payload: unknown, tabId?: number) => {`
);
source = source.replaceAll(
  `send: async (type: InternalMessageType) => {`,
  `send: async (type: InternalMessageType, payload: unknown) => {`
);

if (!source.includes(`navigationRequestId = "navigation-test"`)) throw new Error("navigation helper was not patched");
await writeFile(path, source);
