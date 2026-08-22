/**
 * Pi Matrix Bridge — server-side plugin entry.
 *
 * Owns a single background `pi` child that drives the Matrix bridge
 * connection (see src/server/session.ts). Exposes a small REST + WS surface
 * so the dashboard settings page can configure the connection, pair trusted
 * users, and control the session lifecycle:
 *
 *   GET  /api/pi-matrix-bridge/status   → { state, pid, exitReason, logs }
 *   GET  /api/pi-matrix-bridge/config   → flattened view of the native bridge file + session-side store
 *   POST /api/pi-matrix-bridge/config   → write connection + trusted users back to the native file
 *   POST /api/pi-matrix-bridge/start    → start the background session
 *   POST /api/pi-matrix-bridge/stop     → stop it
 *   POST /api/pi-matrix-bridge/restart  → stop then start with latest config
 *
 * The NATIVE bridge file (~/.pi/matrix-bridge.json, schema of the upstream
 * `pi-matrix-bridge` extension: top-level `matrix` + `auth`) is the single
 * source of truth for connection + pairing config. It is read once at
 * registration into an in-memory snapshot; every save via POST /config
 * refreshes the snapshot. The dashboard plugin store only carries session-side
 * fields (workspace, autoConnect, encryption). State changes are pushed to
 * subscribers via ctx.broadcastToSubscribers({ type: "pi-matrix-bridge_status", ... }).
 *
 * The optional second `opts` argument is test-only dependency injection
 * (spawn impl + bridge file target); the dashboard loader calls registerPlugin(ctx)
 * with a single argument and gets the production defaults.
 */
import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import type { MatrixBridgeConfig } from "../types.js";
import { BridgeConfigError, type BridgeConfigInput, type BridgeFileJson, bridgeFilePath, flattenBridgeFile, readBridgeFile, writeBridgeConfig } from "./bridge-file.js";
import { BackgroundSession, type SpawnImpl } from "./session.js";

export type { MatrixBridgeConfig };

/** Test-only injection seam. Production callers omit this. */
export interface ServerBridgeOptions {
  spawnImpl?: SpawnImpl;
  filePath?: string;
}

const STATUS_TYPE = "pi-matrix-bridge_status" as never;
const REPLAY_TYPE = "pi-matrix-bridge_status_replay" as never;
const FORWARD_TYPE = "pi-matrix-bridge_forward" as never;
const PREFIX = "/api/pi-matrix-bridge";

let cleanupInstalled = false;

export default async function registerPlugin(
  ctx: ServerPluginContext,
  opts: ServerBridgeOptions = {},
): Promise<void> {
  // Snapshot of the native bridge file (connection + pairing source of truth).
  // Read once at registration; refreshed by every POST /config save. A missing
  // or invalid file yields null → connection-less boot (session side still works).
  let fileValues: BridgeFileJson | null = await readBridgeFile(opts.filePath ?? bridgeFilePath());

  // Session-side config, read fresh from the dashboard plugin store on every call.
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

  // Merge: connection + pairing come from the native file snapshot, session-side
  // fields from the store. trustedUsers are de-prefixed + deduped across both.
  const effective = (): MatrixBridgeConfig => {
    const flat = flattenBridgeFile(fileValues);
    const store = readConfig();
    return {
      homeserverUrl: flat.homeserverUrl,
      accessToken: flat.accessToken,
      encryption: store.encryption,
      autoConnect: store.autoConnect,
      session: store.session,
      auth: { trustedUsers: [...new Set([...flat.trustedUsers, ...store.auth.trustedUsers])] },
    };
  };

  const bridge = new BackgroundSession(
    effective,
    opts.spawnImpl,
    (info) => ctx.broadcastToSubscribers({ type: STATUS_TYPE, info, logs: bridge.logs }),
  );

  ctx.broadcastToSubscribers({ type: STATUS_TYPE, info: bridge.info(), logs: bridge.logs });

  // Auto-start when configured (design D5): a native file with connection
  // details + store autoConnect=true brings the bridge up on boot.
  const initial = effective();
  if (initial.autoConnect && initial.homeserverUrl && initial.accessToken) {
    const res = await bridge.start();
    if (!res.ok) ctx.logger.warn(`matrix-bridge auto-start skipped: ${res.reason}`);
  }

  ctx.fastify.register(
    async (r) => {
      r.get("/status", async () => ({ ok: true, ...bridge.info(), logs: bridge.logs }));
      // Flattened view of the effective config (native file connection/pairing + store session-side).
      r.get("/config", async () => ({ ok: true, ...effective() }));
      // Persist connection + pairing back to the native bridge file and refresh the snapshot.
      r.post("/config", async (req, rep) => {
        const raw = (req.body ?? {}) as Partial<BridgeConfigInput>;
        const input: BridgeConfigInput = {
          homeserverUrl: typeof raw.homeserverUrl === "string" ? raw.homeserverUrl : "",
          accessToken: typeof raw.accessToken === "string" ? raw.accessToken : "",
          trustedUsers: Array.isArray(raw.trustedUsers)
            ? raw.trustedUsers.filter((u): u is string => typeof u === "string")
            : [],
        };
        try {
          fileValues = await writeBridgeConfig(input, opts.filePath ?? bridgeFilePath());
        } catch (err) {
          if (err instanceof BridgeConfigError) {
            return rep.code(400).send({ ok: false, error: err.message });
          }
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(`matrix-bridge config write failed: ${message}`);
          return rep.code(500).send({ ok: false, error: "write failed" });
        }
        return { ok: true, ...effective() };
      });
      r.post("/start", async () => {
        const res = await bridge.start();
        return { ok: res.ok, reason: res.reason, ...bridge.info() };
      });
      r.post("/stop", async () => {
        await bridge.stop();
        return { ok: true, ...bridge.info() };
      });
      r.post("/restart", async () => {
        const res = await bridge.restart();
        return { ok: res.ok, reason: res.reason, ...bridge.info() };
      });
    },
    { prefix: PREFIX },
  );

  // Client asks for a fresh state/log snapshot when the settings page opens
  // (spec R5). Reply via broadcast so any subscribed client receives it.
  ctx.registerBrowserHandler(REPLAY_TYPE, () => {
    ctx.broadcastToSubscribers({ type: STATUS_TYPE, info: bridge.info(), logs: bridge.logs });
  });

  // Reserved proactive-push pathway (spec R7 / design D5). This runtime exposes
  // the transport-attributed sessionId only via ctx.onEvent((sessionId, event)) —
  // NOT as a second arg on registerPiHandler (single-arg). So the seam is an
  // onEvent observer: it records forwarded pi events gated to the paired
  // (trustedUsers non-empty) scope, using the transport sessionId (never any
  // sessionId claimed inside the event body). Not wired to forwarding into the
  // bridge conversation yet — documented future extension point.
  ctx.onEvent((sessionId, event) => {
    const ev = event as { eventType?: unknown };
    if (!ev?.eventType) return;
    if ((effective().auth?.trustedUsers?.length ?? 0) === 0) return; // pairing gate
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