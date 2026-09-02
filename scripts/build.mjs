import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const watching = process.argv.includes("--watch");

const originConfig = JSON.parse(await readFile(resolve(root, "config/allowed-origins.json"), "utf8"));
const extraOrigins = (process.env.FLORMIA_EXTRA_WEB_APP_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const webAppMatches = [...new Set([...originConfig.production, ...originConfig.development, ...extraOrigins])];

const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const webAppScript = manifest.content_scripts.find((item) => item.js.includes("content/web-app-bridge.js"));
if (!webAppScript) throw new Error("manifest.json no declara el puente de la Web-App.");
webAppScript.matches = webAppMatches;
manifest.host_permissions = [...new Set(["https://web.whatsapp.com/*", ...webAppMatches])];

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "popup"), { recursive: true });
await mkdir(resolve(dist, "diagnostics"), { recursive: true });
await writeFile(resolve(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await cp(resolve(root, "src/popup/index.html"), resolve(dist, "popup/index.html"));
await cp(resolve(root, "src/popup/popup.css"), resolve(dist, "popup/popup.css"));
await cp(resolve(root, "src/popup/user-facing.css"), resolve(dist, "popup/user-facing.css"));
await cp(resolve(root, "src/popup/optimistic-controls.js"), resolve(dist, "popup/optimistic-controls.js"));
await cp(resolve(root, "src/diagnostics/report.html"), resolve(dist, "diagnostics/report.html"));
await cp(resolve(root, "src/diagnostics/report.css"), resolve(dist, "diagnostics/report.css"));

const builds = [
  {
    entryPoints: [resolve(root, "src/background/recovery-bootstrap.ts")],
    outfile: resolve(dist, "background/service-worker.js"),
    format: "esm"
  },
  {
    entryPoints: [resolve(root, "src/content/whatsapp.ts")],
    outfile: resolve(dist, "content/whatsapp.js"),
    format: "iife"
  },
  {
    entryPoints: [resolve(root, "src/content/inbox-runtime.ts")],
    outfile: resolve(dist, "content/inbox-runtime.js"),
    format: "iife"
  },
  {
    entryPoints: [resolve(root, "src/content/web-app-bridge.ts")],
    outfile: resolve(dist, "content/web-app-bridge.js"),
    format: "iife"
  },
  {
    entryPoints: [resolve(root, "src/content/inbox-web-app-bridge.ts")],
    outfile: resolve(dist, "content/inbox-web-app-bridge.js"),
    format: "iife"
  },
  {
    entryPoints: [resolve(root, "src/popup/popup.ts")],
    outfile: resolve(dist, "popup/popup.js"),
    format: "esm"
  },
  {
    entryPoints: [resolve(root, "src/diagnostics/report.ts")],
    outfile: resolve(dist, "diagnostics/report.js"),
    format: "esm"
  }
];

const shared = {
  bundle: true,
  sourcemap: true,
  target: "chrome120",
  platform: "browser",
  logLevel: "info",
  legalComments: "none"
};

if (watching) {
  const contexts = await Promise.all(builds.map((options) => context({ ...shared, ...options })));
  await Promise.all(contexts.map((item) => item.watch()));
  console.log("Watching extension sources…");
} else {
  await Promise.all(builds.map((options) => build({ ...shared, ...options })));
  console.log(`Extension built in ${dist}`);
}
