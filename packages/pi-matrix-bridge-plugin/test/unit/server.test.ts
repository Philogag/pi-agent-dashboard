import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import registerPlugin from "../../src/server/index.js";
import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";

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

function makeCtx(config: Record<string, unknown>): { ctx: ServerPluginContext; state: CtxState } {
  const state: CtxState = {
    browserHandlers: [],
    broadcasts: [],
    spawnCalls: 0,
    lastSpawn: undefined,
    onEventHandlers: [],
  };
  const ctx = {
    fastify: {
      register: (_fn: unknown, opts?: { prefix?: string }) => {
        state.registerPrefix = opts?.prefix;
      },
    },
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

const completeConfig = {
  homeserverUrl: "https://matrix.example.org",
  accessToken: "syt_secret",
  encryption: true,
  autoConnect: true,
  session: { workspace: "/tmp/ws" },
  auth: { trustedUsers: ["@alice:example.org"] },
};

describe("registerPlugin (server wiring)", () => {
  it("registers REST prefix + replay browser handler and mirrors config with matrix: prefix", async () => {
    const { ctx, state } = makeCtx(completeConfig);
    const dir = mkdtempSync(join(tmpdir(), "mbr-mirror-"));
    const target = join(dir, "matrix-bridge.json");

    await registerPlugin(ctx, { mirrorTarget: target, spawnImpl: () => fakeChild() as never });

    // REST routes under the plugin namespace.
    expect(state.registerPrefix).toBe("/api/pi-matrix-bridge");
    // Browser replay handler registered for settings-page open.
    expect(state.browserHandlers).toContain("pi-matrix-bridge_status_replay");
    // Mirror written with matrix: prefix + token kept (plain user id in config).
    expect(existsSync(target)).toBe(true);
    const mirror = JSON.parse(readFileSync(target, "utf8"));
    expect(mirror.auth.trustedUsers).toEqual(["matrix:@alice:example.org"]);
    expect(mirror.accessToken).toBe("syt_secret");
    // A status broadcast was emitted after wiring.
    expect(state.broadcasts.some((b) => (b as { type?: string }).type === "pi-matrix-bridge_status")).toBe(true);
  });

  it("auto-starts the background session when config is complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-workspace-")); // real, existing workspace
    const target = join(dir, "matrix-bridge.json");
    const cfg = { ...completeConfig, session: { workspace: dir } };
    const { ctx, state } = makeCtx(cfg);

    await registerPlugin(ctx, {
      mirrorTarget: target,
      spawnImpl: (_cmd, _args, opts) => {
        state.spawnCalls += 1;
        state.lastSpawn = opts;
        return fakeChild() as never;
      },
    });

    expect(state.spawnCalls).toBe(1);
    const env = (state.lastSpawn as { env?: Record<string, string> })?.env ?? {};
    expect(env.PI_MATRIX_BRIDGE_HOMESERVER).toBe("https://matrix.example.org");
    expect(env.PI_MATRIX_BRIDGE_ACCESS_TOKEN).toBe("syt_secret");
    expect(env.PI_MATRIX_BRIDGE_AUTO_CONNECT).toBe("1");
  });

  it("does not auto-start when config is incomplete", async () => {
    const { ctx, state } = makeCtx({ homeserverUrl: "", accessToken: "", autoConnect: true, session: {}, auth: { trustedUsers: [] } });
    const dir = mkdtempSync(join(tmpdir(), "mbr-mirror-"));
    const target = join(dir, "matrix-bridge.json");

    // Incomplete config → auto-connect requires homeserver+token; no spawn.
    await registerPlugin(ctx, {
      mirrorTarget: target,
      spawnImpl: () => {
        state.spawnCalls += 1;
        return fakeChild() as never;
      },
    });

    expect(state.spawnCalls).toBe(0);
    // Nothing configured → mirror file NOT created.
    expect(existsSync(target)).toBe(false);
  });

  it("reserved pathway: records other-session events with unspoofable transport sessionId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-fwd-"));
    const target = join(dir, "matrix-bridge.json");
    const { ctx, state } = makeCtx({ homeserverUrl: "", accessToken: "", session: {}, auth: { trustedUsers: ["@alice:example.org"] } });

    await registerPlugin(ctx, { mirrorTarget: target, spawnImpl: () => fakeChild() as never });

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

    await registerPlugin(ctx, { mirrorTarget: target, spawnImpl: () => fakeChild() as never });

    state.onEventHandlers[0]("session-X", { eventType: "some_event" });
    const forwards = state.broadcasts.filter((b) => (b as { type?: string }).type === "pi-matrix-bridge_forward");
    expect(forwards).toHaveLength(0);
  });
});
