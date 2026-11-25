// Bundles Node Services (and the Voice workers it starts) with esbuild into
// the files `tsc` would write, inside `output` laid out like the package:
//
//   dist/{main,document/worker,…}.js
//   node_modules/@linger/voice-runtime/dist/{main,agent,…}.js
//
// Node Services finds its workers and prompts from its package directory
// (src/paths.ts), which each entry gets as LINGER_PACKAGE_ROOT; the Voice
// workers sit beside each other as in dist/. Packages with native code or
// files they load at runtime stay external and come from the production
// node_modules (see build-native-runtime.mjs).
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// Native addons, wasm or worker files these packages read beside themselves,
// or child processes they start from their own files.
export const NODE_SERVICES_EXTERNALS = [
  "@livekit/*",
  "@napi-rs/canvas",
  "@napi-rs/canvas-*",
  "better-sqlite3",
  "sharp",
  "@img/*",
  "pdfjs-dist",
  "jsdom",
  // Loads file-type, pdfjs-dist and its parsers by name at runtime.
  "officeparser",
  // Development only: source files register it when they run as .ts.
  "tsx",
];

const NODE_SERVICES_ENTRIES = [
  "main",
  "document/worker",
  "document/computation-worker",
  "document-normalizer/document-normalizer-worker",
];
const VOICE_ENTRIES = ["main", "agent", "recorder-agent", "live-agent"];

// The package directory as a URL relative to the bundled file `outputFile`.
export const packageRootFrom = (outputFile) =>
  `${path.posix.relative(path.posix.dirname(outputFile), ".") || "."}/`;

async function bundle(repo, output, entry, outputFile, define = {}) {
  const result = await build({
    absWorkingDir: repo,
    entryPoints: [path.join(repo, entry)],
    outfile: path.join(output, outputFile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    // The source exports of workspace packages, like `tsx` in development.
    conditions: ["import", "node"],
    mainFields: ["module", "main"],
    external: NODE_SERVICES_EXTERNALS,
    define,
    legalComments: "none",
    minifyWhitespace: true,
    minifySyntax: true,
    metafile: true,
    logLevel: "warning",
    banner: {
      // CommonJS dependencies inside the bundle require Node's builtins.
      js: 'import { createRequire as __lingerRequire } from "node:module"; const require = __lingerRequire(import.meta.url);',
    },
  });
  return result.metafile;
}

export async function bundleNodeServices(repo, output, options = {}) {
  const voiceRuntimeDir =
    options.voiceRuntimeDir ?? "node_modules/@linger/voice-runtime";
  const files = [];
  const inputs = new Set();
  // Bare imports the bundles left for node_modules.
  const imports = new Set();
  const record = (metafile) => {
    for (const [file, info] of Object.entries(metafile.outputs)) {
      files.push({ file, bytes: info.bytes });
      for (const input of Object.keys(info.inputs)) inputs.add(input);
      for (const item of info.imports)
        if (item.external && !item.path.startsWith("node:"))
          imports.add(item.path);
    }
  };
  const nodeServices = (entry, outputFile) =>
    bundle(repo, output, entry, outputFile, {
      LINGER_PACKAGE_ROOT: JSON.stringify(packageRootFrom(outputFile)),
    });
  const metafiles = await Promise.all([
    ...NODE_SERVICES_ENTRIES.map((entry) =>
      nodeServices(`apps/node-services/src/${entry}.ts`, `dist/${entry}.js`),
    ),
    ...VOICE_ENTRIES.map((entry) =>
      bundle(
        repo,
        output,
        `apps/voice-runtime/src/${entry}.ts`,
        `${voiceRuntimeDir}/dist/${entry}.js`,
      ),
    ),
    // Waits for TeamHub and restarts the service after a crash, as in
    // development (scripts/dev-supervisor.ts --compiled).
    nodeServices(
      "apps/node-services/scripts/dev-supervisor.ts",
      "dist/supervisor.js",
    ),
  ]);
  for (const metafile of metafiles) record(metafile);
  const worker = "src/agent/observability/agent-log-file-worker.mjs";
  await mkdir(path.join(output, "dist/agent/observability"), {
    recursive: true,
  });
  await copyFile(
    path.join(repo, "apps/node-services", worker),
    path.join(output, "dist/agent/observability/agent-log-file-worker.mjs"),
  );
  // Copy the Node 26 V2 ESM resolution hook beside dist/supervisor.js so
  // decoupled V2 bundles resolve external packages from LINGER_NODE_DEPS_DIR
  // without symlinks or node_modules/@linger/voice-runtime conflicts.
  const hookSource = path.join(
    repo,
    "packages/local-installation/src/v2-esm-resolve.mjs",
  );
  await copyFile(hookSource, path.join(output, "dist/v2-esm-resolve.mjs")).catch(
    () => undefined,
  );
  // The worker's package exports and module type.
  await mkdir(path.join(output, voiceRuntimeDir), { recursive: true });
  await writeFile(
    path.join(output, voiceRuntimeDir, "package.json"),
    JSON.stringify(
      {
        name: "@linger/voice-runtime",
        private: true,
        type: "module",
        exports: {
          ".": { default: "./dist/main.js" },
          "./worker": { default: "./dist/main.js" },
        },
      },
      null,
      2,
    ),
  );
  if (options.writePackageJson) {
    await writeFile(
      path.join(output, "package.json"),
      `${JSON.stringify(
        { name: "@linger/node-services", private: true, type: "module" },
        null,
        2,
      )}\n`,
    );
  }
  return { files, inputs: [...inputs], imports };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rawArgs = process.argv.slice(2);
  const v2Layout = rawArgs.includes("--v2");
  const importsJsonIdx = rawArgs.indexOf("--imports-json");
  const importsJsonPath =
    importsJsonIdx >= 0 ? rawArgs[importsJsonIdx + 1] : undefined;
  const positional = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--imports-json") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    positional.push(arg);
  }
  const [repo, output] = positional;
  const result = await bundleNodeServices(
    path.resolve(repo),
    path.resolve(output),
    v2Layout
      ? { voiceRuntimeDir: "voice-runtime", writePackageJson: true }
      : {},
  );
  if (importsJsonPath) {
    const resolvedImportsPath = path.resolve(importsJsonPath);
    await mkdir(path.dirname(resolvedImportsPath), { recursive: true });
    await writeFile(
      resolvedImportsPath,
      `${JSON.stringify([...result.imports].sort(), null, 2)}\n`,
      "utf8",
    );
  }
  for (const { file, bytes } of result.files)
    console.log(`${(bytes / 1e6).toFixed(2).padStart(7)} MB ${file}`);
  console.log([...result.imports].sort().join("\n"));
}
