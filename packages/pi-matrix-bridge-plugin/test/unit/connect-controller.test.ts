import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INIT_PROMPT, runConnectController, waitForLock } from "../../src/server/connect-controller.js";
import type { BackgroundSession } from "../../src/server/session.js";

/** Minimal session surface the controller drives. */
function fakeSession(): { sendRpc: ReturnType<typeof vi.fn> } {
  return { sendRpc: vi.fn() };
}

const baseOpts = () => ({
  homeserverUrl: "https://matrix.example.org",
  accessToken: "syt_token",
  trustedUsers: ["@alice:example.org", "matrix:@bob:example.org"],
});

describe("waitForLock", () => {
  it("resolves true as soon as the lock file appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-lock-"));
    const lockPath = join(dir, "bridge.lock");
    setTimeout(() => writeFileSync(lockPath, "123:abc"), 150);

    const timer = Date.now();
    await expect(waitForLock(lockPath, 50, 5000)).resolves.toBe(true);
    expect(Date.now() - timer).toBeGreaterThanOrEqual(100);
    expect(existsSync(lockPath)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves false once the timeout elapses without the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-lock-"));
    const lockPath = join(dir, "never.node"); // never written
    const timer = Date.now();

    await expect(waitForLock(lockPath, 20, 120)).resolves.toBe(false);
    expect(Date.now() - timer).toBeGreaterThanOrEqual(100);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runConnectController", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ room_id: "!probe:example.org" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pushes /matrix-bridge connect + init prompt and DMs trusted users after the lock appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-ctrl-"));
    const lockPath = join(dir, "bridge.lock");
    writeFileSync(lockPath, "4242:instance"); // already connected
    const session = fakeSession();

    await runConnectController(session as unknown as BackgroundSession, {
      ...baseOpts(),
      lockPath,
      lockPollMs: 10,
      lockTimeoutMs: 1000,
    });

    expect(session.sendRpc).toHaveBeenNthCalledWith(1, "/matrix-bridge connect", "matrix-connect");
    expect(session.sendRpc).toHaveBeenNthCalledWith(2, DEFAULT_INIT_PROMPT, "matrix-init-prompt");

    // One DM per trusted user: createRoom + send each.
    expect(fetchMock.mock.calls.length).toBe(4);
    const createCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/_matrix/client/v3/createRoom"));
    expect(createCalls).toHaveLength(2);
    const invites = createCalls.map((c) => JSON.parse(c[1]?.body as string).invite);
    expect(invites).toContainEqual(["@alice:example.org"]);
    expect(invites).toContainEqual(["@bob:example.org"]); // prefix stripped before invite
    const sendCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/send/m.room.message"));
    expect(sendCalls).toHaveLength(2);
    for (const [, init] of sendCalls) {
      expect(JSON.parse((init as { body: string }).body).body).toBe("✅ Matrix 桥已连接");
    }
    expect(fetchMock.mock.calls[0][1]?.headers?.Authorization).toBe("Bearer syt_token");
    rmSync(dir, { recursive: true, force: true });
  });

  it("on lock timeout warns, still sends the init prompt, and DMs with the warning text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-ctrl-"));
    const lockPath = join(dir, "bridge.lock"); // never written
    const session = fakeSession();
    const warn = vi.fn();

    await runConnectController(session as unknown as BackgroundSession, {
      ...baseOpts(),
      lockPath,
      lockPollMs: 5,
      lockTimeoutMs: 60,
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/did not report connected/));
    expect(session.sendRpc).toHaveBeenNthCalledWith(2, DEFAULT_INIT_PROMPT, "matrix-init-prompt");
    const sendCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/send/m.room.message"));
    expect(sendCalls.length).toBe(2);
    expect(JSON.parse(sendCalls[0][1]?.body as string).body).toContain("⚠️ Matrix 桥未能在超时内确认连接");
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips DMs entirely when the connection is incomplete (still sends connect + prompt)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-ctrl-"));
    const lockPath = join(dir, "bridge.lock");
    writeFileSync(lockPath, "4242:instance");
    const session = fakeSession();

    await runConnectController(session as unknown as BackgroundSession, {
      homeserverUrl: "",
      accessToken: "",
      trustedUsers: ["@alice:example.org"],
      lockPath,
      lockPollMs: 10,
      lockTimeoutMs: 1000,
    });

    expect(session.sendRpc).toHaveBeenNthCalledWith(1, "/matrix-bridge connect", "matrix-connect");
    expect(fetchMock).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });
});