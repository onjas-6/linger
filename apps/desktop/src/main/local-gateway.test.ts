import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalGatewayService, parseLoopbackAdminUrl } from "./local-gateway.js";

describe("parseLoopbackAdminUrl", () => {
  it("accepts only loopback 127.0.0.1:<port> addresses", () => {
    expect(parseLoopbackAdminUrl("127.0.0.1:18480")).toBe(
      "http://127.0.0.1:18480",
    );
    expect(parseLoopbackAdminUrl("http://127.0.0.1:18481/")).toBe(
      "http://127.0.0.1:18481",
    );
    expect(parseLoopbackAdminUrl("0.0.0.0:18480")).toBeUndefined();
    expect(
      parseLoopbackAdminUrl("https://evil.example.com:443"),
    ).toBeUndefined();
    expect(parseLoopbackAdminUrl("127.0.0.1:0")).toBeUndefined();
    expect(parseLoopbackAdminUrl("127.0.0.1:99999")).toBeUndefined();
    expect(parseLoopbackAdminUrl(undefined)).toBeUndefined();
  });
});

describe("LocalGatewayService", () => {
  const dirs: string[] = [];

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "linger-local-gw-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  function fakeClipboard() {
    let text = "";
    return {
      get current() {
        return text;
      },
      writeText: vi.fn(async (next: string) => {
        text = next;
      }),
      readText: vi.fn(async () => text),
      clear: vi.fn(() => {
        text = "";
      }),
    };
  }

  it("reads gateway metadata without returning the password, reveals on demand, and auto-clears clipboard after 60s", async () => {
    vi.useFakeTimers();
    const root = await tempDir();
    const home = path.join(root, "linger-home");
    const toolsDir = path.join(home, "runtime", "localmodels", "tools");
    const bifrostDir = path.join(home, "runtime", "localmodels", "bifrost");
    await mkdir(toolsDir, { recursive: true });
    await mkdir(bifrostDir, { recursive: true });

    await writeFile(
      path.join(toolsDir, "owned.json"),
      JSON.stringify({
        gateway: {
          bifrost: {
            addr: "127.0.0.1:18480",
            app_dir: bifrostDir,
          },
        },
      }),
    );
    await writeFile(
      path.join(bifrostDir, "config.json"),
      JSON.stringify({
        governance: {
          auth_config: {
            admin_username: "admin",
            disable_auth_on_inference: true,
          },
        },
      }),
    );
    const pwFile = path.join(bifrostDir, "admin-password");
    await writeFile(pwFile, "super-secret-bifrost-pw\n", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(pwFile, 0o600);

    const clipboard = fakeClipboard();
    const openExternal = vi.fn(async () => {});
    const showFile = vi.fn();
    const service = new LocalGatewayService({
      home: () => home,
      runtimeEnvironment: () => ({
        LINGER_LOCALMODELS_STATE: path.join(
          home,
          "runtime",
          "localmodels",
          "state",
        ),
      }),
      clipboard,
      openExternal,
      showFile,
      homedir: () => path.join(root, "fake-user-home"),
    });

    const info = await service.getInfo();
    expect(info).toEqual({
      available: true,
      adminUrl: "http://127.0.0.1:18480",
      username: "admin",
      hasPassword: true,
      inferenceAuthDisabled: true,
    });
    expect(JSON.stringify(info)).not.toContain("super-secret-bifrost-pw");

    expect(await service.revealPassword()).toEqual({
      password: "super-secret-bifrost-pw",
    });

    const copied = await service.copyPassword();
    expect(copied).toEqual({ copied: true, clearAfterMs: 60_000 });
    expect(clipboard.current).toBe("super-secret-bifrost-pw");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(clipboard.clear).toHaveBeenCalledOnce();
    expect(clipboard.current).toBe("");

    // Does not clear clipboard if the user copied something else meanwhile.
    await service.copyPassword();
    await clipboard.writeText("something-else");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clipboard.clear).toHaveBeenCalledOnce();

    await service.openAdmin();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:18480",
    );

    await service.openFolder();
    expect(showFile).toHaveBeenCalledExactlyOnceWith(pwFile);
    service.dispose();
  });

  it("refuses world-readable or symlinked admin-password files on POSIX", async () => {
    if (process.platform === "win32") return;
    const root = await tempDir();
    const home = path.join(root, "linger-home");
    const bifrostDir = path.join(home, "runtime", "localmodels", "bifrost");
    await mkdir(bifrostDir, { recursive: true });
    await writeFile(path.join(bifrostDir, "config.json"), "{}");
    const pwFile = path.join(bifrostDir, "admin-password");
    await writeFile(pwFile, "too-open-pw\n", { mode: 0o644 });
    await chmod(pwFile, 0o644);

    const service = new LocalGatewayService({
      home: () => home,
      runtimeEnvironment: () => undefined,
      clipboard: fakeClipboard(),
      openExternal: vi.fn(async () => {}),
      showFile: vi.fn(),
      homedir: () => path.join(root, "fake-user-home"),
    });

    expect(await service.getInfo()).toMatchObject({
      available: true,
      hasPassword: false,
    });
    await expect(service.revealPassword()).rejects.toThrow(
      /missing or not private/,
    );

    // Symlinked password file is also rejected.
    const realTarget = path.join(root, "target-pw");
    await writeFile(realTarget, "symlink-pw\n", { mode: 0o600 });
    await chmod(realTarget, 0o600);
    await rm(pwFile);
    await symlink(realTarget, pwFile);

    await expect(service.revealPassword()).rejects.toThrow(
      /missing or not private/,
    );
    service.dispose();
  });

  it("returns available: false when no local Bifrost gateway exists", async () => {
    const root = await tempDir();
    const service = new LocalGatewayService({
      home: () => path.join(root, "empty-home"),
      runtimeEnvironment: () => undefined,
      clipboard: fakeClipboard(),
      openExternal: vi.fn(async () => {}),
      showFile: vi.fn(),
      homedir: () => path.join(root, "fake-user-home"),
    });
    expect(await service.getInfo()).toEqual({ available: false });
    await expect(service.openAdmin()).rejects.toThrow(/not available/);
    service.dispose();
  });
});
