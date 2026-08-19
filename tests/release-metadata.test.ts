import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as Record<string, unknown>;
}

describe("extension release metadata", () => {
  it("keeps manifest, package and lockfile versions coherent", () => {
    const manifest = readJson("manifest.json");
    const packageJson = readJson("package.json");
    const lock = readJson("package-lock.json");
    const packages = lock.packages as Record<string, Record<string, unknown>>;

    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.version_name).toBe(packageJson.version);
    expect(lock.version).toBe(packageJson.version);
    expect(packages[""]?.version).toBe(packageJson.version);
    expect(String(packageJson.version)).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
