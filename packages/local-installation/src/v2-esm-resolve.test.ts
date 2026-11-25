import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { resolveBundleRuntimeEnv } from "./native-runtime.js";

const runExec = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("V2 Node 26 ESM module.registerHooks() resolution (P0-3)", () => {
  it("resolves external ESM, CJS, scoped packages, and sibling @linger/voice-runtime in a real Node 26 subprocess with zero local node_modules and propagates to child workers via NODE_OPTIONS", async () => {
    // Include a space in the root path to prove file:// URL encoding in NODE_OPTIONS
    // works cleanly on macOS ("Application Support") and Windows ("Program Files").
    const root = await mkdtemp(path.join(tmpdir(), "linger v2 esm "));
    tempDirs.push(root);

    const bundleDir = path.join(root, "store", "backend", "backend-abc123", "node-services");
    const voiceDir = path.join(bundleDir, "voice-runtime");
    const depsDir = path.join(root, "infra", "node-deps", "nd-1234567890abcdef");

    // 1. Isolated business bundle directory: NO node_modules directory exists anywhere inside it.
    await mkdir(path.join(bundleDir, "dist"), { recursive: true });
    await mkdir(path.join(voiceDir, "dist"), { recursive: true });

    // 2. Externalized shared node-native-deps cache
    const esmPkgDir = path.join(depsDir, "node_modules", "fake-esm-pkg");
    const cjsPkgDir = path.join(depsDir, "node_modules", "fake-cjs-pkg");
    const scopedPkgDir = path.join(depsDir, "node_modules", "@livekit", "fake-rtc");
    await mkdir(esmPkgDir, { recursive: true });
    await mkdir(cjsPkgDir, { recursive: true });
    await mkdir(scopedPkgDir, { recursive: true });

    await writeFile(
      path.join(esmPkgDir, "package.json"),
      JSON.stringify({
        name: "fake-esm-pkg",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.mjs" },
      }),
    );
    await writeFile(
      path.join(esmPkgDir, "index.mjs"),
      'export const esmGreeting = "hello-from-external-esm";\n',
    );

    await writeFile(
      path.join(cjsPkgDir, "package.json"),
      JSON.stringify({
        name: "fake-cjs-pkg",
        version: "1.0.0",
        main: "index.cjs",
      }),
    );
    await writeFile(
      path.join(cjsPkgDir, "index.cjs"),
      'module.exports = { cjsAnswer: 42 };\n',
    );

    await writeFile(
      path.join(scopedPkgDir, "package.json"),
      JSON.stringify({
        name: "@livekit/fake-rtc",
        version: "1.0.0",
        type: "module",
        exports: {
          ".": "./index.mjs",
          "./room": "./room.mjs",
        },
      }),
    );
    await writeFile(
      path.join(scopedPkgDir, "index.mjs"),
      'export const rtcVersion = "rtc-v2";\n',
    );
    await writeFile(
      path.join(scopedPkgDir, "room.mjs"),
      'export const roomReady = true;\n',
    );

    // 3. Sibling @linger/voice-runtime outside node_modules (zero directory conflict)
    await writeFile(
      path.join(voiceDir, "package.json"),
      JSON.stringify({
        name: "@linger/voice-runtime",
        private: true,
        type: "module",
        exports: {
          ".": { default: "./dist/main.js" },
          "./worker": { default: "./dist/main.js" },
        },
      }),
    );
    await writeFile(
      path.join(voiceDir, "dist", "main.js"),
      [
        'import { rtcVersion } from "@livekit/fake-rtc";',
        'import { roomReady } from "@livekit/fake-rtc/room";',
        'export const voiceWorkerStatus = { rtcVersion, roomReady };',
      ].join("\n"),
    );

    // 4. Child worker script (spawned WITHOUT --import in argv to prove NODE_OPTIONS propagation)
    const childScript = path.join(bundleDir, "dist", "child-worker.mjs");
    await writeFile(
      childScript,
      [
        'import { esmGreeting } from "fake-esm-pkg";',
        'import { voiceWorkerStatus } from "@linger/voice-runtime/worker";',
        'process.stdout.write(JSON.stringify({ childEsm: esmGreeting, childVoice: voiceWorkerStatus }));',
      ].join("\n"),
    );

    // 5. Main isolated bundle entry (tests static ESM, scoped subpath, CJS default + createRequire, voice-runtime, and child worker)
    const entryScript = path.join(bundleDir, "dist", "app.mjs");
    await writeFile(
      entryScript,
      [
        'import { execFileSync } from "node:child_process";',
        'import { createRequire } from "node:module";',
        'import { esmGreeting } from "fake-esm-pkg";',
        'import cjsDefault from "fake-cjs-pkg";',
        'import { voiceWorkerStatus } from "@linger/voice-runtime/worker";',
        'const req = createRequire(import.meta.url);',
        'const cjsRequired = req("fake-cjs-pkg");',
        `const childOut = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(childScript)}], { encoding: "utf8" }));`,
        'process.stdout.write(JSON.stringify({ esmGreeting, cjsDefault, cjsRequired, voiceWorkerStatus, childOut }));',
      ].join("\n"),
    );

    const hookPath = fileURLToPath(
      new URL("./v2-esm-resolve.mjs", import.meta.url),
    );
    const runtimeEnv = resolveBundleRuntimeEnv({
      nodeDepsDir: depsDir,
      voiceRuntimeDir: voiceDir,
      esmResolveHookPath: hookPath,
    });

    const { stdout } = await runExec(
      process.execPath,
      ["--import", hookPath, entryScript],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          ...runtimeEnv,
        },
      },
    );

    const parsed = JSON.parse(stdout) as {
      esmGreeting: string;
      cjsDefault: { cjsAnswer: number };
      cjsRequired: { cjsAnswer: number };
      voiceWorkerStatus: { rtcVersion: string; roomReady: boolean };
      childOut: {
        childEsm: string;
        childVoice: { rtcVersion: string; roomReady: boolean };
      };
    };
    expect(parsed).toEqual({
      esmGreeting: "hello-from-external-esm",
      cjsDefault: { cjsAnswer: 42 },
      cjsRequired: { cjsAnswer: 42 },
      voiceWorkerStatus: { rtcVersion: "rtc-v2", roomReady: true },
      childOut: {
        childEsm: "hello-from-external-esm",
        childVoice: { rtcVersion: "rtc-v2", roomReady: true },
      },
    });
  });
});
