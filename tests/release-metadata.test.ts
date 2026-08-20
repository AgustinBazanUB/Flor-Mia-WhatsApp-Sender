import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as Record<string, unknown>;
}

describe("extension release metadata", () => {
  it("keeps the Chrome release version internally coherent", () => {
    const manifest = readJson("manifest.json");

    expect(manifest.version_name).toBe(manifest.version);
    expect(String(manifest.version)).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("keeps npm workspace and lockfile metadata coherent", () => {
    const packageJson = readJson("package.json");
    const lock = readJson("package-lock.json");
    const packages = lock.packages as Record<string, Record<string, unknown>>;

    expect(lock.version).toBe(packageJson.version);
    expect(packages[""]?.version).toBe(packageJson.version);
    expect(String(packageJson.version)).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
