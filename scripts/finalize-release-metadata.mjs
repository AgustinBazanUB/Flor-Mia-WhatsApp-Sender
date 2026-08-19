import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const targetVersion = packageJson.version;
if (targetVersion !== "0.9.2") throw new Error(`Expected package.json 0.9.2, got ${targetVersion}`);

const lockPath = resolve(root, "package-lock.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
lock.version = targetVersion;
if (!lock.packages?.[""]) throw new Error("package-lock.json is missing packages[''] metadata");
lock.packages[""].version = targetVersion;
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

const workflow = `name: verify

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  statuses: write

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@v5
      - name: Node.js 20
        uses: actions/setup-node@v5
        with:
          node-version: 20
          cache: npm
      - name: Install locked dependencies
        run: npm ci
      - name: Verify
        id: verify
        run: npm run verify
      - name: Publish aggregate verify status
        if: always() && github.event_name == 'push'
        env:
          GH_TOKEN: \${{ github.token }}
          REPOSITORY: \${{ github.repository }}
          COMMIT_SHA: \${{ github.sha }}
          VERIFY_OUTCOME: \${{ steps.verify.outcome }}
        shell: bash
        run: |
          if [ "$VERIFY_OUTCOME" = "success" ]; then state=success; else state=failure; fi
          description="npm run verify: $VERIFY_OUTCOME"
          payload=$(jq -n --arg state "$state" --arg context "verify/npm" --arg description "$description" '{state:$state,context:$context,description:$description}')
          curl --fail-with-body --silent --show-error \\
            --request POST \\
            --header "Authorization: Bearer $GH_TOKEN" \\
            --header "Accept: application/vnd.github+json" \\
            "https://api.github.com/repos/$REPOSITORY/statuses/$COMMIT_SHA" \\
            --data "$payload"
`;
await writeFile(resolve(root, ".github/workflows/verify.yml"), workflow, "utf8");
await unlink(new URL(import.meta.url));
console.log(`Final release metadata synchronized to ${targetVersion}.`);
