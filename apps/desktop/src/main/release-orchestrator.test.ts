import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LocalReleaseDescriptor } from "@linger/local-installation/release-descriptor";
import { BundleStoreModule } from "./bundle-store.js";
import { ConfigStore } from "./config.js";
import { HealthWatchdogModule } from "./health-watchdog.js";
import { EventBus, ModuleHost } from "./modules.js";
import {
  ReleaseOrchestratorModule,
  diffReleaseModules,
} from "./release-orchestrator.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeRelease(
  appVersion: string,
  hashes: Partial<Record<keyof LocalReleaseDescriptor["modules"], string>> = {},
  rollbackSafe = true,
): LocalReleaseDescriptor {
  const h = (mod: keyof LocalReleaseDescriptor["modules"]) =>
    (hashes[mod] ?? "1").padEnd(64, "0").slice(0, 64);
  const mk = (mod: keyof LocalReleaseDescriptor["modules"]) => ({
    artifactId: `${mod}-${h(mod).slice(0, 12)}`,
    originAppVersion: appVersion,
    sha256: h(mod),
    path: `store/${mod}/${mod}-${h(mod).slice(0, 12)}`,
  });
  return {
    schema: 1,
    appVersion,
    channel: "stable",
    installedAt: new Date().toISOString(),
    source: "incremental-update",
    compat: {
      minShellVersion: "0.2.0",
      minNativeDepsHash: `sha256:${"a".repeat(64)}`,
      runnerGatewayProtocol: 1,
      dbSchemaEpoch: 892,
      rollbackSafe,
    },
    infra: {
      node: "infra/node/v26",
      postgres: "infra/postgres/pg17",
      voiceTools: "infra/voice-tools/lk1",
      nodeDeps: "infra/node-deps/nd-aaaaaaaaaaaaaaaa",
    },
    modules: {
      web: mk("web"),
      backend: mk("backend"),
    },
  };
}

describe("ReleaseOrchestratorModule & HealthWatchdogModule", () => {
  it("classifies web-only diff as zero-downtime hot reload and backend diff as atomic drain restart", () => {
    const v1 = makeRelease("0.2.14");
    const v2Web = makeRelease("0.2.15", { web: "2" });
    const v2Backend = makeRelease("0.2.15", { backend: "2" });

    expect(diffReleaseModules(v1, v2Web)).toMatchObject({
      scope: "web",
      action: "reload-page",
      requiresDrain: false,
      changedModules: ["web"],
    });
    expect(diffReleaseModules(v1, v2Backend)).toMatchObject({
      scope: "backend",
      action: "restart-services",
      requiresDrain: true,
      changedModules: ["backend"],
    });
  });

  it("drains active tasks before backend restart, rolls back on failed health probe + restores DB backup, and auto-rolls back on post-commit crashes", async () => {
    const home = await makeTempDir("linger-orch-home-");
    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const watchdog = new HealthWatchdogModule();
    const config = new ConfigStore(path.join(home, "config.json"));
    const bus = new EventBus();

    let activeOps = 1;
    let probeHealthy = false;
    const restarted: string[] = [];
    const backups: string[] = [];
    const restored: string[] = [];
    const rolledBackEvents: string[] = [];
    bus.on("release.rolled_back", (from, to) =>
      rolledBackEvents.push(`${from}->${to}`),
    );

    const orch = new ReleaseOrchestratorModule({
      activeOperations: () => activeOps,
      backupDatabase: async (ver) => {
        const file = `instances/desktop/backups/pre-${ver}.dump`;
        backups.push(file);
        return file;
      },
      restoreDatabase: async (file) => {
        restored.push(file);
      },
      restartServices: async (rel) => {
        restarted.push(rel.appVersion);
      },
      buildHealthProbes: () => [
        { name: "teamhub-healthz", check: async () => probeHealthy },
      ],
      healthGateTimeoutMs: 60,
      healthGateIntervalMs: 15,
      observationWindowMs: 5_000,
      observationMaxCrashes: 2,
    });

    const host = new ModuleHost(
      [
        { name: "Config", dependsOn: [], start: async () => {}, stop: async () => {} },
        store,
        watchdog,
        orch,
      ],
      { config, log: noopLog, bus },
    );
    await host.start();

    // Seed 0.2.14 as current healthy release
    await store.writeReleaseDescriptor(makeRelease("0.2.14"));
    await store.beginPending({
      appVersion: "0.2.14",
      releaseFile: "releases/0.2.14/release.json",
      updatedAt: new Date().toISOString(),
    });
    await store.commitPending();

    // Stage 0.2.15 (non-rollbackSafe backend change) while activeOps=1
    await store.writeReleaseDescriptor(
      makeRelease("0.2.15", { backend: "2" }, false),
    );
    await orch.onBundleStaged("0.2.15");
    expect(orch.state().kind).toBe("ready");

    // Attempt apply while busy -> enters waiting!
    expect(await orch.applyStaged()).toBe(false);
    expect(orch.state().kind).toBe("waiting");

    // Drain completes, probe fails -> backs up DB, fails healthcheck, restores DB, rolls back to 0.2.14 & denylists 0.2.15!
    activeOps = 0;
    expect(await orch.applyStaged()).toBe(false);
    expect(backups).toEqual(["instances/desktop/backups/pre-0.2.15.dump"]);
    expect(restored).toEqual(["instances/desktop/backups/pre-0.2.15.dump"]);
    expect((await store.readCurrent())?.appVersion).toBe("0.2.14");
    expect(await store.isDenylisted("0.2.15")).toBe(true);
    expect(rolledBackEvents).toContain("0.2.15->0.2.14");

    // Stage 0.2.16 (healthy at gate), commit succeeds, then 2 crashes in observation window trigger automatic rollback!
    probeHealthy = true;
    await store.writeReleaseDescriptor(makeRelease("0.2.16", { backend: "3" }));
    await orch.onBundleStaged("0.2.16");
    expect(await orch.applyStaged()).toBe(true);
    expect((await store.readCurrent())?.appVersion).toBe("0.2.16");
    expect(watchdog.isObserving("0.2.16")).toBe(true);

    // 1st crash does not rollback yet; 2nd crash triggers automatic rollback to 0.2.14!
    expect(await watchdog.recordCrash("node-services", "OOM")).toBe(false);
    expect(await watchdog.recordCrash("node-services", "OOM")).toBe(true);
    expect((await store.readCurrent())?.appVersion).toBe("0.2.14");
    expect(await store.isDenylisted("0.2.16")).toBe(true);
    expect(rolledBackEvents).toContain("0.2.16->0.2.14");
    // Post-commit crash rollback must NEVER call restoreDatabase
    expect(restored).toEqual(["instances/desktop/backups/pre-0.2.15.dump"]);

    // Stage 0.2.17 (non-rollbackSafe, healthy at gate so it commits with a backup file),
    // then crashes post-commit: MUST NEVER call restoreDatabase (data-loss guard) and
    // must flag manualRecoveryRequired while preserving the backup path.
    await store.writeReleaseDescriptor(
      makeRelease("0.2.17", { backend: "4" }, false),
    );
    await orch.onBundleStaged("0.2.17");
    expect(await orch.applyStaged()).toBe(true);
    expect(backups).toContain("instances/desktop/backups/pre-0.2.17.dump");
    expect((await store.readCurrent())?.appVersion).toBe("0.2.17");
    const restoresBeforeWatchdog = restored.length;

    expect(await watchdog.recordCrash("teamhub", "panic")).toBe(false);
    expect(await watchdog.recordCrash("teamhub", "panic")).toBe(true);
    expect(restored.length).toBe(restoresBeforeWatchdog);
    expect(await store.isDenylisted("0.2.17")).toBe(true);
    expect((await store.readCurrent())?.appVersion).toBe("0.2.17");
    expect(orch.rollbackNotice()).toMatchObject({
      fromVersion: "0.2.17",
      toVersion: "0.2.17",
      manualRecoveryRequired: true,
      dbBackupFile: "instances/desktop/backups/pre-0.2.17.dump",
    });

    await host.stop("quit");
  });
});
