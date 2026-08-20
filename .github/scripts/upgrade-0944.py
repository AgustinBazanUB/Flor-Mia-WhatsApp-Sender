from pathlib import Path
import base64
import gzip

parts = []
for index in range(6):
    parts.append(Path(f".github/scripts/upgrade-0944.payload-{index}").read_text().strip())
payload = "".join(parts)
source = gzip.decompress(base64.b64decode(payload)).decode("utf-8")
source = source.replace('WhatsApp Web quede utilizable.",\n\'\'\',', 'WhatsApp Web quede utilizable.", {\n\'\'\',')
source = source.replace('WhatsApp Web quede utilizable.",\n\'\'\')', 'WhatsApp Web quede utilizable.", {\n\'\'\')')
source = source.replace('// Sólo cambios estructurales durante esta espera acotada.\n\'\'\'', '// Sólo cambios estructurales durante esta espera acotada. No observamos atributos\n\'\'\'')
source = source.replace('campaignId: context.campaignId ?? "manual",', 'campaignId: state.activeCampaign?.campaignId ?? "extension",')
source = source.replace('cancelRequested: boolean;', 'cancelRequested?: boolean;')
source = source.replace('  createdAt: string;\n  startedAt: string | null;', '  createdAt?: string;\n  startedAt: string | null;')
source = source.replace('.map(({ key: _key, campaignId: _campaignId, ...recipient }) => recipient);', '.map((record) => {\n          const recipient = { ...record };\n          delete (recipient as Partial<StoredRecipient>).key;\n          delete (recipient as Partial<StoredRecipient>).campaignId;\n          return recipient as CampaignRecipientState;\n        });')
source += r"""
regex_once("src/content/web-app-bridge.ts",
  r'''    const responsePayload = request\.type === WEB_APP_MESSAGE_TYPES\.deleteRequest[\s\S]*?: status as unknown as Record<string, unknown>;''',
  '''    const responsePayload = status as unknown as Record<string, unknown>;''')
regex_once("src/background/service-worker.ts",
  r'''async function refreshDiagnosticIncident\([\s\S]*?\n}\n\nasync function generateDiagnosticReport''',
  '''async function generateDiagnosticReport''')
replace_once("src/background/service-worker.ts",
  '''import type { CampaignPublicStatus, CampaignState } from "../campaign/campaign-types";''',
  '''import type { CampaignPublicStatus } from "../campaign/campaign-types";''')
replace_once("tests/campaign-engine.test.ts",
'''  it("keeps Stop as intent while an ambiguous post-click result awaits reconciliation", async () => {
    const { engine, runner, checkpoints } = setup(2);
    runner.outcomes.set("contact-1", ["ambiguous"]);
    runner.onAmbiguous = async () => { await engine.requestStop("campaign-1"); };
    const result = await startAndAdvance(engine, 1);
    expect(result.status).toBe("paused");
    expect(result.stopRequested).toBe(true);
    expect(result.blockReason?.code).toBe("contact_ambiguous");
    expect(checkpoints.active?.steps[0]?.status).toBe("verification_pending");
    expect(result.recipients[1]?.status).toBe("pending");
  });''',
'''  it("Stop terminalizes at the safe boundary while preserving ambiguous post-click evidence", async () => {
    const { engine, runner, checkpoints } = setup(2);
    runner.outcomes.set("contact-1", ["ambiguous"]);
    runner.onAmbiguous = async () => { await engine.requestStop("campaign-1"); };
    const result = await startAndAdvance(engine, 1);
    expect(result.status).toBe("stopped");
    expect(result.stopRequested).toBe(true);
    expect(checkpoints.active?.steps[0]?.status).toBe("verification_pending");
    expect(checkpoints.active?.steps[0]?.verification?.sendAttempted).toBe(true);
    expect(result.recipients[1]?.status).toBe("pending");
  });''')
replace_once("tests/campaign-runtime-finalization.test.ts",
'''  it("refuses stopped cleanup while post-click evidence is still ambiguous", async () => {
    const paused = campaign("paused");
    const stopped: CampaignState = {
      ...paused,
      status: "stopped",
      currentRecipientIndex: null,
      activeContactId: null,
      stopRequested: true,
      stoppedAt: NOW,
      sequence: 4
    };
    const ambiguous = checkpoint("paused");
    ambiguous.pauseReason = "verification_pending";
    ambiguous.steps = [{
      id: "text",
      operationId: "campaign-final:recipient-1:text",
      position: 1,
      kind: "text",
      text: "Hola",
      status: "verification_pending",
      attempts: 1,
      verification: { outcome: "ambiguous", method: "test", observedAt: NOW, sendAttempted: true }
    }];
    const { runtime, blobs, checkpoints, history } = setup(stopped, ambiguous);
    await expect(runtime.syncCampaign(stopped)).rejects.toThrow(/ambiguo/i);
    expect(blobs.deleted).toEqual([]);
    expect(checkpoints.active).toBe(ambiguous);
    expect(await history.list()).toEqual([]);
  });''',
'''  it("archives a stopped campaign while retaining ambiguous post-click evidence for explicit cancel/review", async () => {
    const paused = campaign("paused");
    const stopped: CampaignState = {
      ...paused,
      status: "stopped",
      currentRecipientIndex: null,
      activeContactId: null,
      stopRequested: true,
      stoppedAt: NOW,
      sequence: 4
    };
    const ambiguous = checkpoint("paused");
    ambiguous.pauseReason = "verification_pending";
    ambiguous.steps = [{
      id: "text",
      operationId: "campaign-final:recipient-1:text",
      position: 1,
      kind: "text",
      text: "Hola",
      status: "verification_pending",
      attempts: 1,
      verification: { outcome: "ambiguous", method: "test", observedAt: NOW, sendAttempted: true }
    }];
    const { runtime, blobs, checkpoints, history } = setup(stopped, ambiguous);
    await expect(runtime.syncCampaign(stopped)).resolves.toMatchObject({ status: "stopped" });
    expect(blobs.deleted).toEqual([]);
    expect(checkpoints.active).toBe(ambiguous);
    expect(await history.list()).toEqual([expect.objectContaining({ status: "stopped" })]);
  });''')
replace_once("tests/technical-trace-store.test.ts",
  '''    expect(records[0]?.traceId).toBe("campaign-a-20");''',
  '''    expect(records[0]?.traceId).toBe(`campaign-a-${520 - MAX_TRACE_RECORDS_PER_CAMPAIGN}`);''')
replace_once("tests/technical-trace-store.test.ts",
'''    await store.appendMany(Array.from({ length: 510 }, (_, index) => trace("campaign-a", index)));
    await store.appendMany(Array.from({ length: 510 }, (_, index) => trace("campaign-b", index)));
    await store.append({ ...trace("campaign-b", 509), outcome: "reconciled" });''',
'''    await store.appendMany(Array.from({ length: 510 }, (_, index) => trace("campaign-a", index)));
    await store.appendMany(Array.from({ length: 510 }, (_, index) => trace("campaign-b", index)));
    await store.appendMany(Array.from({ length: 510 }, (_, index) => trace("campaign-c", index)));
    await store.append({ ...trace("campaign-c", 509), outcome: "reconciled" });''')
replace_once("tests/technical-trace-store.test.ts",
  '''    expect(all.filter((record) => record.traceId === "campaign-b-509")).toHaveLength(1);''',
  '''    expect(all.filter((record) => record.traceId === "campaign-c-509")).toHaveLength(1);''')
"""
exec(compile(source, "upgrade-0944-expanded.py", "exec"))
