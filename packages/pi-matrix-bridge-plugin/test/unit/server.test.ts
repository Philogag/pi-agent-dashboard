import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import registerPlugin from "../../src/server/index.js";

/** Minimal fake child that satisfies what BackgroundSession needs. */
function fakeChild(): EventEmitter & { pid: number; kill: () => boolean } {
  const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => boolean };
  child.pid = 4242;
  child.kill = () => true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

interface CtxState {
  registerPrefix?: string;
  browserHandlers: string[];
  broadcasts: unknown[];
  spawnCalls: number;
  lastSpawn: unknown;
  onEventHandlers: Array<(sessionId: string, event: unknown) => void>;
}

function makeCtx(
  config: Record<string, unknown>,
  fastifyOverride?: unknown,
): { ctx: ServerPluginContext; state: CtxState } {
  const state: CtxState = {
    browserHandlers: [],
    broadcasts: [],
    spawnCalls: 0,
    lastSpawn: undefined,
    onEventHandlers: [],
  };
  const ctx = {
    fastify:
      fastifyOverride ??
      ({
        register: (_fn: unknown, opts?: { prefix?: string }) => {
          state.registerPrefix = opts?.prefix;
        },
      } as never),
    sessionManager: { listActive: () => [], listAll: () => [], getSession: () => undefined },
    eventStore: { getEvents: () => [], getLatestEvent: () => undefined },
    broadcastToSubscribers: (msg: unknown) => state.broadcasts.push(msg),
    registerPiHandler: () => {},
    registerBrowserHandler: (type: string) => state.browserHandlers.push(type),
    onEvent: (handler: (sessionId: string, event: unknown) => void) => {
      state.onEventHandlers.push(handler);
      return () => {};
    },
    onSessionEnded: () => () => {},
    sendToSession: () => false,
    emitEventToSession: () => false,
    spawnSession: async () => ({ success: false }),
    abortSession: () => false,
    abortSpawnedRun: async () => false,
    provide: () => {},
    consume: () => undefined,
    consumeAll: () => [],
    getPluginConfig: () => config,
    updatePluginConfig: async () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ServerPluginContext;
  return { ctx, state };
}

/** Seed the native bridge file at `target` with connection + pairing (extension schema). */
function seedBridgeFile(target: string, matrix: { homeserverUrl: string; accessToken: string }) {
  writeFileSync(
    target,
    JSON.stringify({
      matrix,
      auth: { trustedUsers: ["matrix:@alice:example.org"], channels: { "!room:server": "allow" } },
    }),
    "utf8",
  );
}

describe("registerPlugin (server wiring)", () => {
  it("registers REST prefix + replay browser handler; no bridge file created without config", async () => {
    const { ctx, state } = makeCtx({ enabled: true });
    const dir = mkdtempSync(join(tmpdir(), "mbr-boot-"));
    const target = join(dir, "matrix-bridge.json");

    await registerPlugin(ctx, { filePath: target, spawnImpl: () => fakeChild() as never });

    // REST routes under the plugin namespace.
    expect(state.registerPrefix).toBe("/api/pi-matrix-bridge");
    // Browser replay handler registered for settings-page open.
    expect(state.browserHandlers).toContain("pi-matrix-bridge_status_replay");
    // The plugin never writes the bridge file itself (native file is the source).
    expect(existsSync(target)).toBe(false);
    // A status broadcast was emitted after wiring.
    expect(state.broadcasts.some((b) => (b as { type?: string }).type === "pi-matrix-bridge_status")).toBe(true);
  });

  it("auto-starts from the native bridge file when the store has no connection fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-boot-"));
    const target = join(dir, "matrix-bridge.json");
    seedBridgeFile(target, { homeserverUrl: "https://file.example.org", accessToken: "syt_file_token" });
    const { ctx, state } = makeCtx({ enabled: true, autoConnect: true, session: {}, auth: { trustedUsers: [] } });

    await registerPlugin(ctx, {
      filePath: target,
      spawnImpl: (_cmd, _args, opts) => {
        state.spawnCalls += 1;
        state.lastSpawn = opts;
        return fakeChild() as never;
      },
    });

    expect(state.spawnCalls).toBe(1);
    const env = (state.lastSpawn as { env?: Record<string, string> })?.env ?? {};
    expect(env.PI_MATRIX_BRIDGE_HOMESERVER).toBe("https://file.example.org");
    expect(env.PI_MATRIX_BRIDGE_ACCESS_TOKEN).toBe("syt_file_token");
    expect(env.PI_MATRIX_BRIDGE_AUTO_CONNECT).toBe("1");
  });

  it("does not auto-start without a usable bridge file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-boot-"));
    const target = join(dir, "matrix-bridge.json"); // never created
    const { ctx, state } = makeCtx({ enabled: true, autoConnect: true, session: {}, auth: { trustedUsers: [] } });

    await registerPlugin(ctx, {
      filePath: target,
      spawnImpl: () => {
        state.spawnCalls += 1;
        return fakeChild() as never;
      },
    });

    expect(state.spawnCalls).toBe(0);
  });

  it("reserved pathway: records other-session events with unspoofable transport sessionId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-fwd-"));
    const target = join(dir, "matrix-bridge.json");
    const { ctx, state } = makeCtx({ homeserverUrl: "", accessToken: "", session: {}, auth: { trustedUsers: ["@alice:example.org"] } });

    await registerPlugin(ctx, { filePath: target, spawnImpl: () => fakeChild() as never });

    // The reserved pathway is backed by ctx.onEvent (transport-attributed sessionId).
    expect(state.onEventHandlers).toHaveLength(1);
    // Event body claims a forged sessionId; the pathway must use the transport one.
    state.onEventHandlers[0]("session-X", { eventType: "some_event", data: { sessionId: "forged" } });

    const forwards = state.broadcasts.filter((b) => (b as { type?: string }).type === "pi-matrix-bridge_forward");
    expect(forwards).toHaveLength(1);
    expect(forwards[0]).toMatchObject({ sessionId: "session-X", eventType: "some_event" });
    expect(state.broadcasts.some((b) => (b as { sessionId?: string }).sessionId === "forged")).toBe(false);
  });

  it("reserved pathway: does not forward when no users are paired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-fwd-"));
    const target = join(dir, "matrix-bridge.json");
    const { ctx, state } = makeCtx({ homeserverUrl: "", accessToken: "", session: {}, auth: { trustedUsers: [] } });

    await registerPlugin(ctx, { filePath: target, spawnImpl: () => fakeChild() as never });

    state.onEventHandlers[0]("session-X", { eventType: "some_event" });
    const forwards = state.broadcasts.filter((b) => (b as { type?: string }).type === "pi-matrix-bridge_forward");
    expect(forwards).toHaveLength(0);
  });
});

describe("registerPlugin /config REST surface (real fastify)", () => {
  /** Boot the plugin against a real fastify app backed by a seeded bridge file. */
  async function boot(
    config: Record<string, unknown>,
    target: string,
  ): Promise<{ app: ReturnType<typeof Fastify>; code: (url: string, body?: unknown) => ReturnType<typeof fetch> }> {
    const app = Fastify();
    const { ctx } = makeCtx(config, app);
    await registerPlugin(ctx, { filePath: target, spawnImpl: () => fakeChild() as never });
    const code = async (url: string, body?: unknown) => {
      const res = await app.inject({ method: body === undefined ? "GET" : "POST", url, payload: body ? JSON.stringify(body) : undefined, headers: body ? { "content-type": "application/json" } : undefined });
      return { status: res.statusCode, json: () => res.json() } as never;
    };
    return { app, code };
  }

  it("GET /config returns the flattened native-file view with store session values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-cfg-"));
    const target = join(dir, "matrix-bridge.json");
    seedBridgeFile(target, { homeserverUrl: "https://file.example.org", accessToken: "syt_file_token" });
    const { app, code } = await boot(
      { enabled: true, autoConnect: false, encryption: false, session: { workspace: "/tmp/ws" }, auth: { trustedUsers: [] } },
      target,
    );

    const view = (await code("/api/pi-matrix-bridge/config")).json() as {
      ok: boolean; homeserverUrl: string; accessToken: string; encryption: boolean; autoConnect: boolean;
      session: { workspace: string }; auth: { trustedUsers: string[] };
    };
    expect(view.ok).toBe(true);
    // Connection + pairing come from the file; prefix stripped; token echoed.
    expect(view.homeserverUrl).toBe("https://file.example.org");
    expect(view.accessToken).toBe("syt_file_token");
    expect(view.auth.trustedUsers).toEqual(["@alice:example.org"]);
    // Session-side values come from the store.
    expect(view.autoConnect).toBe(false);
    expect(view.encryption).toBe(false);
    expect(view.session.workspace).toBe("/tmp/ws");
    await app.close();
  });

  it("POST /config writes the nested file (prefix + channels preserved), refreshes snapshot, GET agrees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-cfg-"));
    const target = join(dir, "matrix-bridge.json");
    seedBridgeFile(target, { homeserverUrl: "https://old.example.org", accessToken: "old_token" });
    const { app, code } = await boot({ enabled: true, autoConnect: false, session: {}, auth: { trustedUsers: [] } }, target);

    const saved = (await code("/api/pi-matrix-bridge/config", {
      homeserverUrl: "https://new.example.org",
      accessToken: "tok2",
      trustedUsers: ["@bob:example.org", "@carol:example.org"],
    })).json() as { ok: boolean; homeserverUrl: string; accessToken: string; auth: { trustedUsers: string[] } };
    expect(saved.ok).toBe(true);
    expect(saved.homeserverUrl).toBe("https://new.example.org");
    expect(saved.accessToken).toBe("tok2");
    expect(saved.auth.trustedUsers).toEqual(["@bob:example.org", "@carol:example.org"]);

    // File on disk: nested matrix.*, matrix: prefixed users, channels preserved.
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.matrix).toEqual({ homeserverUrl: "https://new.example.org", accessToken: "tok2" });
    expect(onDisk.auth.trustedUsers).toEqual(["matrix:@bob:example.org", "matrix:@carol:example.org"]);
    expect(onDisk.auth.channels).toEqual({ "!room:server": "allow" });

    // Snapshot was refreshed: an immediate GET sees the same values.
    const after = (await code("/api/pi-matrix-bridge/config")).json() as { homeserverUrl: string; accessToken: string };
    expect(after.homeserverUrl).toBe("https://new.example.org");
    expect(after.accessToken).toBe("tok2");
    await app.close();
  });

  it("POST /config with no file and no connection returns 400 (BridgeConfigError)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-cfg-"));
    const target = join(dir, "matrix-bridge.json"); // never created
    const { app, code } = await boot({ enabled: true, autoConnect: false, session: {}, auth: { trustedUsers: [] } }, target);

    const res = await code("/api/pi-matrix-bridge/config", { homeserverUrl: "", accessToken: "", trustedUsers: [] });
    expect(res.status).toBe(400);
    await app.close();
  });
});