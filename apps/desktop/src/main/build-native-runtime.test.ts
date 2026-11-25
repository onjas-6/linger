import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { copyExternals } from "../../scripts/build-native-runtime.mjs";
import {
  resolveExternalPackageRoots,
  stageV2NodeNativeDeps,
} from "../../scripts/stage-v2-node-native-deps.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// A hoisted node_modules as `pnpm deploy --config.node-linker=hoisted` writes
// it, with officeparser and the dependencies its 8.2.0 manifest declares.
const deployed = () => {
  const root = mkdtempSync(path.join(tmpdir(), "build-native-runtime-"));
  roots.push(root);
  const add = (name: string, dependencies: Record<string, string> = {}) => {
    const directory = path.join(root, "deploy/node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name, version: "1.0.0", dependencies }),
    );
    writeFileSync(path.join(directory, "index.js"), "");
  };
  add("officeparser", { "pdfjs-dist": "1", "tesseract.js": "1" });
  add("pdfjs-dist");
  add("tesseract.js", { "tesseract.js-core": "1", "node-fetch": "1" });
  add("tesseract.js-core");
  add("node-fetch");
  return root;
};

it("leaves out the OCR engine officeparser only loads with OCR on", async () => {
  const root = deployed();
  const output = path.join(root, "output");
  const result = await copyExternals(path.join(root, "deploy"), output, [
    "officeparser",
  ]);
  expect(result.packages.map((item) => item.package).sort()).toEqual([
    "node_modules/officeparser",
    "node_modules/pdfjs-dist",
  ]);
  expect(result.excluded).toEqual({});
  expect(existsSync(path.join(output, "node_modules/officeparser"))).toBe(true);
  for (const name of ["tesseract.js", "tesseract.js-core", "node-fetch"])
    expect(existsSync(path.join(output, "node_modules", name))).toBe(false);
});

it("stages V2 per-target node-native-deps with real external packages, manifest, models.json, and node-services package.json", async () => {
  const workRoot = mkdtempSync(path.join(tmpdir(), "stage-v2-node-deps-"));
  roots.push(workRoot);

  const repoDir = path.join(workRoot, "repo");
  const outDir = path.join(workRoot, "out");
  const nsDir = path.join(workRoot, "node-services");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(
    path.join(repoDir, "pnpm-lock.yaml"),
    [
      "packages:",
      "  '@livekit/local-inference-darwin-arm64@0.1.2':",
      "    resolution: {integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=}",
      "",
    ].join("\n"),
  );

  const rootsList = resolveExternalPackageRoots({
    imports: ["pdfjs-dist/legacy/build/pdf.mjs", "tsx", "node:fs", "sharp"],
    deployedDependencies: [
      "@livekit/rtc-node",
      "@livekit/local-inference",
      "pdfjs-dist",
      "officeparser",
      "sharp",
      "word-extractor",
    ],
  });
  expect(rootsList).toEqual([
    "@livekit/local-inference",
    "@livekit/rtc-node",
    "officeparser",
    "pdfjs-dist",
    "sharp",
    "word-extractor",
  ]);

  const summary = await stageV2NodeNativeDeps({
    repoRoot: repoDir,
    outDir,
    targets: ["darwin-arm64"],
    nodeServicesDir: nsDir,
    imports: ["pdfjs-dist/legacy/build/pdf.mjs", "officeparser", "sharp"],
    runDeploy: async ({ deployDir }) => {
      const addPkg = (
        name: string,
        version: string,
        deps: Record<string, string> = {},
        optionalDeps: Record<string, string> = {},
      ) => {
        const dir = path.join(deployDir, "node_modules", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({
            name,
            version,
            dependencies: deps,
            optionalDependencies: optionalDeps,
          }),
        );
        writeFileSync(path.join(dir, "index.js"), "export default {};\n");
      };
      mkdirSync(deployDir, { recursive: true });
      writeFileSync(
        path.join(deployDir, "package.json"),
        JSON.stringify({
          name: "@linger/node-services",
          dependencies: {
            "@livekit/local-inference": "0.1.2",
            officeparser: "8.2.0",
            "pdfjs-dist": "4.0.0",
            sharp: "0.34.0",
            "word-extractor": "1.0.4",
          },
        }),
      );
      addPkg("pdfjs-dist", "4.0.0");
      addPkg("officeparser", "8.2.0", {
        "pdfjs-dist": "4.0.0",
        "tesseract.js": "5.0.0",
      });
      addPkg("tesseract.js", "5.0.0");
      addPkg("sharp", "0.34.0", {}, { "@img/sharp-darwin-arm64": "0.34.0" });
      addPkg("@img/sharp-darwin-arm64", "0.34.0");
      addPkg("word-extractor", "1.0.4");
      addPkg(
        "@livekit/local-inference",
        "0.1.2",
        {},
        { "@livekit/local-inference-darwin-arm64": "0.1.2" },
      );
      addPkg("@livekit/local-inference-darwin-arm64", "0.1.2");
    },
  });

  expect(summary.targets).toEqual([
    {
      target: "darwin-arm64",
      packageCount: 6,
      excludedModels: ["@livekit/local-inference-darwin-arm64"],
    },
  ]);

  const targetDir = path.join(outDir, "darwin-arm64");
  for (const pkg of [
    "pdfjs-dist",
    "officeparser",
    "sharp",
    "@img/sharp-darwin-arm64",
    "word-extractor",
    "@livekit/local-inference",
  ]) {
    expect(existsSync(path.join(targetDir, "node_modules", pkg, "package.json"))).toBe(true);
  }
  expect(existsSync(path.join(targetDir, "node_modules", "tesseract.js"))).toBe(false);
  expect(
    existsSync(
      path.join(targetDir, "node_modules", "@livekit/local-inference-darwin-arm64"),
    ),
  ).toBe(false);

  const manifest = JSON.parse(
    readFileSync(path.join(targetDir, "node-native-deps-manifest.json"), "utf8"),
  ) as { target: string; packageCount: number; layout: string };
  expect(manifest).toMatchObject({
    target: "darwin-arm64",
    layout: "shared-node-deps",
    packageCount: 6,
  });

  const nsPkg = JSON.parse(
    readFileSync(path.join(nsDir, "package.json"), "utf8"),
  ) as { name: string; private: boolean; type: string };
  expect(nsPkg).toEqual({
    name: "@linger/node-services",
    private: true,
    type: "module",
  });

  const models = JSON.parse(
    readFileSync(path.join(nsDir, "models.json"), "utf8"),
  ) as { packages: Record<string, { group: string; version: string }> };
  expect(models.packages["@livekit/local-inference-darwin-arm64"]).toMatchObject({
    group: "voice",
    version: "0.1.2",
  });
});
