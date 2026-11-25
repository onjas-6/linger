import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import type { BundleModuleId } from "@linger/local-installation/release-descriptor";

import type { HealthProbe } from "./health-watchdog.js";

export interface LocalInstancePorts {
  readonly web: number;
  readonly teamhub: number;
  readonly nodeServices: number;
  readonly document?: number;
  readonly postgres?: number;
}

export interface ResolveToolsNodePathOptions {
  readonly home: string;
  readonly releaseInfraNode?: string;
  readonly resourcesPath?: string;
  readonly isPackaged?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (filePath: string) => boolean;
  readonly readdir?: (dirPath: string) => string[];
}

/**
 * Resolves an existing bundled Node.js executable for `LINGER_TOOLS_NODE_PATH`
 * when `computer-daemon` is hot-reloaded from a V2 `backend` bundle.
 *
 * Returns `undefined` if no candidate exists on disk so we never inject a
 * nonexistent path that causes `localtools.Installed()` to fail in a crash loop.
 */
export function resolveToolsNodePath(
  options: ResolveToolsNodePathOptions,
): string | undefined {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const listDir =
    options.readdir ??
    ((dirPath: string) => {
      try {
        return readdirSync(dirPath);
      } catch {
        return [];
      }
    });
  const env = options.env ?? process.env;
  const nodeExe = platform === "win32" ? "node.exe" : "node";

  const candidates: string[] = [];

  const envOverride = env.LINGER_TOOLS_NODE_PATH?.trim();
  if (envOverride) {
    candidates.push(path.resolve(envOverride));
  }

  if (options.releaseInfraNode) {
    const infraBase = path.join(options.home, options.releaseInfraNode);
    candidates.push(path.join(infraBase, "bin", nodeExe));
    if (platform === "win32") {
      candidates.push(path.join(infraBase, nodeExe));
    }
  }

  if (options.resourcesPath) {
    candidates.push(path.join(options.resourcesPath, "runtime", "bin", nodeExe));
    if (platform === "win32") {
      candidates.push(path.join(options.resourcesPath, "runtime", nodeExe));
    }
  }

  const desktopNodeRoot = path.join(options.home, "desktop", "node");
  const installedVersions = [...listDir(desktopNodeRoot)].sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  );
  for (const versionDir of installedVersions) {
    candidates.push(path.join(desktopNodeRoot, versionDir, "bin", nodeExe));
    if (platform === "win32") {
      candidates.push(path.join(desktopNodeRoot, versionDir, nodeExe));
    }
  }

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export interface BuildV2HealthProbesOptions {
  readonly changed: readonly BundleModuleId[];
  readonly localOrigin?: string;
  readonly isPackaged: boolean;
  readonly loadLocalPorts: () => Promise<LocalInstancePorts | undefined>;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
  readonly probeTimeoutMs?: number;
}

/**
 * Builds pre-commit health probes for V2 incremental releases.
 *
 * Backend probes target TeamHub (`127.0.0.1:<ports.teamhub>/healthz`) and
 * Node Services (`127.0.0.1:<ports.nodeServices>/healthz`) directly rather than
 * Web's `static-host.mjs` `/healthz`, preventing false-positive commits when a
 * faulty backend exits immediately while Web remains up.
 */
export function buildV2HealthProbes(
  options: BuildV2HealthProbesOptions,
): HealthProbe[] {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.probeTimeoutMs ?? 2_500;
  const probes: HealthProbe[] = [];

  if (options.changed.includes("web") && options.localOrigin) {
    const webOrigin = options.localOrigin;
    probes.push({
      name: "web-healthz",
      check: async () => {
        const res = await fetcher(new URL("/healthz", webOrigin), {
          signal: AbortSignal.timeout(timeoutMs),
        }).catch(() => undefined);
        return res?.ok ?? false;
      },
    });
  }

  if (options.changed.includes("backend")) {
    const devTeamhubUrl = !options.isPackaged
      ? (options.env
          ? options.env.LINGER_TEAMHUB_HEALTH_URL
          : process.env.LINGER_TEAMHUB_HEALTH_URL
        )?.trim()
      : undefined;

    probes.push({
      name: "teamhub-healthz",
      check: async () => {
        let teamhubHealthUrl = devTeamhubUrl;
        if (!teamhubHealthUrl) {
          const ports = await options.loadLocalPorts().catch(() => undefined);
          if (!ports?.teamhub) return false;
          teamhubHealthUrl = `http://127.0.0.1:${ports.teamhub}/healthz`;
        }
        const res = await fetcher(teamhubHealthUrl, {
          signal: AbortSignal.timeout(timeoutMs),
        }).catch(() => undefined);
        if (!res?.ok) return false;
        if (env.TEAMHUB_LOCAL_IDENTITY_KEY) {
          const idUrl = new URL("/v0/local/identity", teamhubHealthUrl);
          const idRes = await fetcher(idUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              nonce: randomBytes(32).toString("base64url"),
            }),
            signal: AbortSignal.timeout(timeoutMs),
          }).catch(() => undefined);
          if (!idRes?.ok) return false;
        }
        return true;
      },
    });

    if (!devTeamhubUrl) {
      probes.push({
        name: "node-services-healthz",
        check: async () => {
          const ports = await options.loadLocalPorts().catch(() => undefined);
          if (!ports?.nodeServices) return false;
          const res = await fetcher(
            `http://127.0.0.1:${ports.nodeServices}/healthz`,
            { signal: AbortSignal.timeout(timeoutMs) },
          ).catch(() => undefined);
          return res?.ok ?? false;
        },
      });
    }
  }

  return probes;
}
