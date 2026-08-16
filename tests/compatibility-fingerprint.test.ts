import { describe, expect, it } from "vitest";
import { createDefaultCompatibilityState, evaluateFunctionalCompatibility } from "../src/compatibility/fingerprint";
import { createUnavailablePreflight } from "../src/compatibility/preflight-result";
import type { CapabilityDiscovery, WhatsAppCapability } from "../src/compatibility/types";
import { CompatibilityStore } from "../src/storage/compatibility-store";
import type { KeyValueStorage } from "../src/storage/state-store";
import type { WhatsAppPreflightResult } from "../src/shared/state";
import { CompatibilityManager } from "../src/compatibility/manager";

function available(discovery: CapabilityDiscovery, strategy: string): CapabilityDiscovery {
  return {
    ...discovery,
    state: "available",
    selectedStrategy: strategy,
    attempts: [{ strategyId: strategy, method: "accessibility", priority: 1, result: "matched", matchedCount: 1, candidates: [] }],
    fingerprint: {
      strategyId: strategy,
      method: "accessibility",
      tagName: "button",
      attributes: { role: "button" },
      semanticFingerprint: `button|role=button|${strategy}`
    }
  };
}

function successfulPreflight(strategy = "main.primary"): WhatsAppPreflightResult {
  const result = createUnavailablePreflight("fixture", {
    level: "full",
    requirements: { needsText: false, needsImages: false }
  }, { pageDetected: true, contentScriptConnected: true });
  for (const capability of Object.keys(result.capabilities) as WhatsAppCapability[]) {
    result.capabilities[capability] = available(result.capabilities[capability], capability === "main_interface" ? strategy : `${capability}.working`);
  }
  return {
    ...result,
    documentReady: true,
    sessionReady: true,
    mainInterfaceReady: true,
    operational: true,
    overallStatus: "GREEN",
    status: "ready",
    message: "GREEN"
  };
}

class MemoryStorage implements KeyValueStorage {
  value: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> { return this.value; }
  async set(items: Record<string, unknown>): Promise<void> { this.value = { ...this.value, ...items }; }
}

describe("functional fingerprint and Last Known Good", () => {
  it("stores Last Known Good only after a functional success and persists it", async () => {
    const evaluated = evaluateFunctionalCompatibility(successfulPreflight(), createDefaultCompatibilityState(), "0.4.0");
    const storage = new MemoryStorage();
    await new CompatibilityStore(storage).save(evaluated.state);
    const rehydrated = await new CompatibilityStore(storage).load();
    expect(rehydrated.lastKnownGood.main_interface).toMatchObject({
      extensionVersion: "0.4.0",
      selectedStrategy: "main.primary"
    });
    expect(rehydrated.lastKnownGoodExtensionVersion).toBe("0.4.0");
  });

  it("detects functional drift while remaining GREEN", () => {
    const first = evaluateFunctionalCompatibility(successfulPreflight("main.primary"), createDefaultCompatibilityState(), "0.4.0");
    const drift = evaluateFunctionalCompatibility(successfulPreflight("main.fallback"), first.state, "0.4.0");
    expect(drift.preflight.overallStatus).toBe("GREEN");
    expect(drift.preflight.capabilities.main_interface.change).toBe("drift");
    expect(drift.state.driftHistory.at(-1)).toMatchObject({
      capability: "main_interface",
      fromStrategy: "main.primary",
      toStrategy: "main.fallback"
    });
    expect(drift.state.lastKnownGood.main_interface?.selectedStrategy).toBe("main.fallback");
  });

  it("detects a real break without replacing Last Known Good", () => {
    const first = evaluateFunctionalCompatibility(successfulPreflight("main.primary"), createDefaultCompatibilityState(), "0.4.0");
    const failed = successfulPreflight("main.primary");
    failed.overallStatus = "RED";
    failed.operational = false;
    failed.status = "incompatible";
    failed.capabilities.main_interface = {
      ...failed.capabilities.main_interface,
      state: "unavailable",
      selectedStrategy: undefined,
      fingerprint: undefined
    };
    const broken = evaluateFunctionalCompatibility(failed, first.state, "0.4.0");
    expect(broken.preflight.capabilities.main_interface.change).toBe("break");
    expect(broken.state.lastFailure).toMatchObject({ capability: "main_interface", classification: "break" });
    expect(broken.state.lastKnownGood.main_interface?.selectedStrategy).toBe("main.primary");
  });

  it("does not classify a still-loading page as UI break", () => {
    const first = evaluateFunctionalCompatibility(successfulPreflight("main.primary"), createDefaultCompatibilityState(), "0.4.0");
    const loading = createUnavailablePreflight("Cargando", {}, {
      pageDetected: true,
      contentScriptConnected: false,
      status: "loading"
    });
    const evaluated = evaluateFunctionalCompatibility(loading, first.state, "0.4.0");
    expect(evaluated.state.lastFailure?.classification).toBe("temporary");
    expect(evaluated.state.lastKnownGood.main_interface?.selectedStrategy).toBe("main.primary");
    expect(evaluated.preflight.capabilities.main_interface.change).toBe("unknown");
  });

  it("records a runtime break with only masked contact and checkpoint context", async () => {
    const storage = new MemoryStorage();
    const manager = new CompatibilityManager(new CompatibilityStore(storage), "0.4.0");
    const recorded = await manager.recordRuntimeFailure({
      code: "SELECTOR_STRATEGY_EXHAUSTED",
      message: "Sin selector",
      recoverable: false,
      details: {
        compatibilityDiagnostic: {
          capability: "composer",
          logicalStep: "conversation.composer",
          expectedStrategies: ["composer.primary"],
          currentStrategiesAttempted: [],
          expectedSemanticElement: "editor",
          candidateCount: 0,
          candidateSummaries: [],
          timestamp: "2026-08-15T10:00:00.000Z"
        }
      }
    }, {
      campaignId: "campaign-1",
      maskedContact: "+54••••••78",
      stepId: "text",
      attempts: 1,
      lastSuccessfulCapability: "open_conversation"
    });
    expect(recorded?.failure).toMatchObject({
      capability: "composer",
      maskedContact: "+54••••••78",
      stepId: "text",
      attempts: 1,
      lastSuccessfulCapability: "open_conversation"
    });
    expect(JSON.stringify(recorded)).not.toContain("5491112345678");
  });

  it("consumes the next-health-check development fault exactly once", async () => {
    const storage = new MemoryStorage();
    const store = new CompatibilityStore(storage);
    await store.setDevelopmentFault("next_health_check_break");
    expect(await store.consumeHealthCheckFault()).toBe("main_interface_capability_break");
    expect(await store.consumeHealthCheckFault()).toBe("none");
    expect((await store.load()).developmentFault).toBe("none");
  });

  it("migrates schema 1 forward without losing Last Known Good", async () => {
    const storage = new MemoryStorage();
    const legacy = evaluateFunctionalCompatibility(successfulPreflight(), createDefaultCompatibilityState(), "0.5.0").state;
    storage.value.whatsappCompatibilityState = {
      ...legacy,
      schemaVersion: 1,
      lastKnownGoodExtensionVersion: undefined
    };
    const migrated = await new CompatibilityStore(storage).load();
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.lastKnownGoodExtensionVersion).toBe("0.5.0");
    expect(migrated.lastKnownGood.main_interface?.selectedStrategy).toBe("main.primary");
  });
});
