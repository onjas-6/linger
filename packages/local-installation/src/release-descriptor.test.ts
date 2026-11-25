import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLE_RUNTIME_SCHEMA,
  parseNativeRuntime,
  resolveBundleRuntimeEnv,
} from "./native-runtime.js";
import { planBundleNativeCommand } from "./native-source.js";
import {
  parseLocalReleaseDescriptor,
  parseReleasePointer,
  readJsonIfExists,
  resolveSafeHomePath,
  writeJsonAtomic,
  type LocalReleaseDescriptor,
} from "./release-descriptor.js";
import { parseTeamhubBinaries } from "./teamhub-binaries.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("V2 local-installation release descriptors & decoupled bundles", () => {
  it("parses V2 runtime & teamhub manifests without sourceArchiveSha256", () => {
    const rt = parseNativeRuntime({
      schema: BUNDLE_RUNTIME_SCHEMA,
      target: "darwin-arm64",
      artifactId: "node-services-a1b2c3d4e5f6",
      nativeDepsHash: `sha256:${"a".repeat(64)}`,
      files: {
        "dist/main.js": { bytes: 100, sha256: "b".repeat(64) },
      },
    });
    expect(rt.artifactId).toBe("node-services-a1b2c3d4e5f6");
    expect(rt.sourceArchiveSha256).toBeUndefined();

    const th = parseTeamhubBinaries({
      target: "darwin-arm64",
      artifactId: "teamhub-darwin-arm64-a1b2c3d4e5f6",
      goVersion: "1.26.0",
      binaries: {
        teamhub: { file: "teamhub", sha256: "c".repeat(64), bytes: 10 },
        migrate: { file: "migrate", sha256: "d".repeat(64), bytes: 10 },
        account: { file: "account", sha256: "e".repeat(64), bytes: 10 },
      },
    });
    expect(th.artifactId).toBe("teamhub-darwin-arm64-a1b2c3d4e5f6");
    expect(th.sourceArchiveSha256).toBeUndefined();
  });

  it("writes/reads release descriptors atomically, blocks path escapes, and plans bundle commands", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "linger-li-"));
    tempDirs.push(home);

    expect(() => resolveSafeHomePath(home, "../escape")).toThrow("Unsafe relative path");
    expect(() => resolveSafeHomePath(home, "/etc/passwd")).toThrow("Unsafe relative path");

    const mk = (mod: string) => ({
      artifactId: `${mod}-111111111111`,
      originAppVersion: "0.2.15",
      sha256: "a".repeat(64),
      path: `store/${mod}/${mod}-111111111111`,
    });
    const descriptor: LocalReleaseDescriptor = {
      schema: 1,
      appVersion: "0.2.15",
      channel: "stable",
      installedAt: "2026-11-24T12:00:00Z",
      source: "incremental-update",
      compat: {
        minShellVersion: "0.2.0",
        minNativeDepsHash: `sha256:${"a".repeat(64)}`,
        runnerGatewayProtocol: 1,
        dbSchemaEpoch: 892,
        rollbackSafe: true,
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

    const file = path.join(home, "releases/0.2.15/release.json");
    await writeJsonAtomic(file, descriptor);
    const loaded = await readJsonIfExists(file, parseLocalReleaseDescriptor);
    expect(loaded?.appVersion).toBe("0.2.15");

    const ptrFile = path.join(home, "state/current.json");
    await writeJsonAtomic(ptrFile, {
      appVersion: "0.2.15",
      releaseFile: "releases/0.2.15/release.json",
      updatedAt: "2026-11-24T12:00:00Z",
    });
    expect((await readJsonIfExists(ptrFile, parseReleasePointer))?.appVersion).toBe("0.2.15");

    const nodeEnv = resolveBundleRuntimeEnv({
      nodeDepsDir: path.join(home, "infra/node-deps/nd-aaaaaaaaaaaaaaaa"),
      promptsDir: path.join(home, "store/backend/backend-111111111111/node-services/prompts"),
    });
    expect(nodeEnv.NODE_PATH).toContain("nd-aaaaaaaaaaaaaaaa");
    expect(nodeEnv.LINGER_PROMPTS_DIR).toContain("prompts");

    const webCmd = planBundleNativeCommand("web", home, descriptor, {
      platform: "darwin",
      webControlToken: "tok123",
    });
    expect(webCmd.command).toBe(path.join(home, "infra/node/v26/bin/node"));
    expect(webCmd.args[0]).toBe(
      path.join(home, "store/web/web-111111111111/static-host.mjs"),
    );
    expect(webCmd.env.LINGER_WEB_CONTROL_TOKEN).toBe("tok123");

    const thCmd = planBundleNativeCommand("teamhub", home, descriptor, {
      platform: "win32",
    });
    expect(thCmd.command).toBe(
      path.join(home, "store/backend/backend-111111111111/teamhub/teamhub.exe"),
    );
    expect(thCmd.env.TEAMHUB_SKILLS_DIR).toBe(
      path.join(home, "store/backend/backend-111111111111/skills"),
    );

    const nsCmd = planBundleNativeCommand("node-services", home, descriptor, {
      platform: "darwin",
    });
    expect(nsCmd.args[0]).toBe("--import");
    expect(nsCmd.args[1]).toContain("v2-esm-resolve.mjs");
    expect(nsCmd.args[2]).toBe("--conditions=linger-production");
    expect(nsCmd.args[3]).toBe(
      path.join(home, "store/backend/backend-111111111111/node-services/dist/supervisor.js"),
    );
    expect(nsCmd.env.LINGER_NODE_DEPS_DIR).toBe(
      path.join(home, "infra/node-deps/nd-aaaaaaaaaaaaaaaa"),
    );
    expect(nsCmd.env.LINGER_VOICE_RUNTIME_DIR).toBe(
      path.join(home, "store/backend/backend-111111111111/node-services/voice-runtime"),
    );
    expect(nsCmd.env.NODE_OPTIONS).toContain("--import=file://");
    expect(nsCmd.env.LINGER_PROMPTS_DIR).toBe(
      path.join(home, "store/backend/backend-111111111111/node-services/prompts"),
    );
  });
});
