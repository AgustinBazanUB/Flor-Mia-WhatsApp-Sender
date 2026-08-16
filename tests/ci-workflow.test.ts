import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("continuous integration", () => {
  it("runs the locked install and complete verify command on GitHub Actions", async () => {
    const workflow = await readFile(".github/workflows/verify.yml", "utf8");
    expect(workflow).toContain("node-version: 20");
    expect(workflow).toContain("run: npm ci");
    expect(workflow).toContain("run: npm run verify");
    expect(workflow).not.toContain("continue-on-error");
  });
});
