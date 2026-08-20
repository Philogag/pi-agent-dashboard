/**
 * Pi Matrix Bridge — server-side plugin entry.
 *
 * Owns a single background `pi` child that drives the Matrix bridge
 * connection (see src/server/session.ts). Exposes a small REST + WS surface
 * so the dashboard settings page can configure the connection, pair trusted
 * users, and control the session lifecycle:
 *
 *   GET  /api/pi-matrix-bridge/status   → { state, pid, exitReason, logs }
 *   POST /api/pi-matrix-bridge/start    → start the background session
 *   POST /api/pi-matrix-bridge/stop     → stop it
 *   POST /api/pi-matrix-bridge/restart  → stop then start with latest config
 *
 * Config is read fresh via ctx.getPluginConfig() on every lifecycle action
 * (mirrors what the settings UI persisted), and mirrored to
 * ~/.pi/matrix-bridge.json (0600) so a manually-run desktop pi shares the
 * same connection/pairing config. State changes are pushed to subscribers
 * via ctx.broadcastToSubscribers({ type: "pi-matrix-bridge_status", ... }).
 *
 * The optional second `opts` argument is test-only dependency injection
 * (spawn impl + mirror target); the dashboard loader calls registerPlugin(ctx)
 * with a single argument and gets the production defaults.
 */
import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import { BackgroundSession, type SpawnImpl } from "./session.js";
import { writeBridgeFile } from "./mirror.js";
import type { MatrixBridgeConfig } from "../types.js";

export type { MatrixBridgeConfig };

/** Test-only injection seam. Production callers omit this. */
export interface ServerBridgeOptions {
  spawnImpl?: SpawnImpl;
  mirrorTarget?: string;
}

const STATUS_TYPE = "pi-matrix-bridge_status" as never;
const MIRROR_ERROR_TYPE = "pi-matrix-bridge_mirror_error" as never;
const REPLAY_TYPE = "pi-matrix-bridge_status_replay" as never;
const FORWARD_TYPE = "pi-matrix-bridge_forward" as never;
const PREFIX = "/api/pi-matrix-bridge";

let cleanupInstalled = false;

export default async function registerPlugin(
  ctx: ServerPluginContext,
  opts: ServerBridgeOptions = {},
): Promise<void> {
  // Read the latest persisted config on every call so a config change from the
  // settings UI is reflected on the next lifecycle action.
  const readConfig = (): MatrixBridgeConfig => {
    const raw = (ctx.getPluginConfig<Partial<MatrixBridgeConfig>>() ?? {}) as Partial<MatrixBridgeConfig>;
    return {
      homeserverUrl: raw.homeserverUrl ?? "",
      accessToken: raw.accessToken ?? "",
      encryption: raw.encryption ?? true,
      autoConnect: raw.autoConnect ?? true,
      session: { workspace: raw.session?.workspace ?? "" },
      auth: { trustedUsers: raw.auth?.trustedUsers ?? [] },
    };
  };

  const broadcastStatus = () =>
    ctx.broadcastToSubscribers({ type: STATUS_TYPE, info: bridge.info(), logs: bridge.logs });

  const bridge = new BackgroundSession(
    readConfig,
    opts.spawnImpl,
    (info) => ctx.broadcastToSubscribers({ type: STATUS_TYPE, info, logs: bridge.logs }),
  );

  // Mirror connection/pairing config to ~/.pi/matrix-bridge.json (design D1).
  // Best-effort: a mirror failure is logged + surfaced, never fatal.
  const runMirror = async (cfg: MatrixBridgeConfig): Promise<void> => {
    // Don't create the mirror file until something is actually configured.
    if (!cfg.homeserverUrl && cfg.auth.trustedUsers.length === 0) return;
    try {
      await writeBridgeFile(cfg, opts.mirrorTarget);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`matrix-bridge mirror failed: ${message}`);
      ctx.broadcastToSubscribers({ type: MIRROR_ERROR_TYPE, error: message });
    }
  };

  await runMirror(readConfig());
  ctx.broadcastToSubscribers({ type: STATUS_TYPE, info: bridge.info(), logs: bridge.logs });

  // Auto-start when configured (design D3): a fresh registration that already
  // has connection details brings the bridge up without manual intervention.
  const initial = readConfig();
  if (initial.autoConnect && initial.homeserverUrl && initial.accessToken) {
    const res = await bridge.start();
    if (!res.ok) ctx.logger.warn(`matrix-bridge auto-start skipped: ${res.reason}`);
  }

  ctx.fastify.register(
    async (r) => {
      r.get("/status", async () => ({ ok: true, ...bridge.info(), logs: bridge.logs }));
      r.post("/start", async () => {
        await runMirror(readConfig()); // keep desktop-shared mirror fresh on each action
        const res = await bridge.start();
        return { ok: res.ok, reason: res.reason, ...bridge.info() };
      });
      r.post("/stop", async () => {
        await runMirror(readConfig());
        await bridge.stop();
        return { ok: true, ...bridge.info() };
      });
      r.post("/restart", async () => {
        await runMirror(readConfig());
        const res = await bridge.restart();
        return { ok: res.ok, reason: res.reason, ...bridge.info() };
      });
    },
    { prefix: PREFIX },
  );

  // Client asks for a fresh state/log snapshot when the settings page opens
  // (spec R5). Reply via broadcast so any subscribed client receives it.
  ctx.registerBrowserHandler(REPLAY_TYPE, async () => {
    ctx.broadcastToSubscribers({ type: STATUS_TYPE, info: bridge.info(), logs: bridge.logs });
  });

  // Reserved proactive-push pathway (spec R7 / design D5). This runtime exposes
  // the transport-attributed sessionId only via ctx.onEvent((sessionId, event)) —
  // NOT as a second arg on registerPiHandler (single-arg) as the plan assumed.
  // So the seam is an onEvent observer: it records forwarded pi events gated to
  // the paired (trustedUsers non-empty) scope, using the transport sessionId
  // (never any sessionId claimed inside the event body). Not wired to forwarding
  // into the bridge conversation yet — documented future extension point.
  ctx.onEvent((sessionId, event) => {
    const ev = event as { eventType?: unknown };
    if (!ev?.eventType) return;
    if ((readConfig().auth?.trustedUsers?.length ?? 0) === 0) return; // pairing gate
    ctx.broadcastToSubscribers({
      type: FORWARD_TYPE,
      sessionId,
      eventType: String(ev.eventType),
    });
  });

  // Tear down the child on host shutdown so we never orphan a `pi` process.
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    const shutdown = () => void bridge.detach();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }

  ctx.logger.info("pi-matrix-bridge server entry ready");
}
