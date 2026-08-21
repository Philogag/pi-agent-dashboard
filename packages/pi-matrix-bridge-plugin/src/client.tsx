/**
 * Pi Matrix Bridge — dashboard plugin client entry.
 *
 * Renders a settings-section contribution with three panels:
 *   A. Matrix connection config (homeserver, token, E2EE, auto-connect, workspace)
 *   B. Trusted-user pairing (managed as @user:server ids, mirror gets matrix: prefix)
 *   C. Background session status/logs + lifecycle controls
 *
 * Matches the server surface in src/server/index.ts. Config is persisted via
 * plugin_config_write; session state is read via the plugin's REST endpoints
 * (REST polling — the client runtime exposes no generic WS-subscription hook,
 * see design.md reconciliation).
 *
 * Styling follows the dashboard's native convention: Tailwind utility classes
 * over the theme CSS variables (the bg / text / border / accent token families) so the
 * form tracks the active theme. The plugin's `src` branch is listed in the
 * client's index.css `@source` directives so Tailwind v4 does not purge these
 * classes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  usePluginConfig,
  usePluginSend,
} from "@blackbelt-technology/dashboard-plugin-runtime/context";
import type { SlotProps } from "@blackbelt-technology/pi-dashboard-shared/dashboard-plugin/slot-props.js";
import { EMPTY_CONFIG, isUserMatrixId, type MatrixBridgeConfig } from "./types.js";

const API = "/api/pi-matrix-bridge";

// ── native theme classes (Tailwind v4 + theme CSS vars) ──────────────
const INPUT_CLS =
  "text-xs rounded bg-[var(--bg-tertiary)] border border-[var(--border-primary)] " +
  "text-[var(--text-primary)] placeholder-[var(--text-muted)] px-2 py-1 " +
  "focus:outline-none focus:border-[var(--accent-blue)]";
const MONO_INPUT_CLS = `${INPUT_CLS} font-mono`;
const BTN_PRIMARY =
  "text-xs px-3 py-1.5 rounded bg-[var(--accent-primary)] text-white font-medium " +
  "hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_SECONDARY =
  "px-2 py-1 text-xs rounded bg-[var(--bg-secondary)] border border-[var(--border-secondary)] " +
  "text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_DANGER =
  "px-2 py-0.5 text-xs rounded border border-[var(--severity-error-border)] " +
  "bg-[var(--severity-error-bg)] text-[var(--severity-error-fg)] hover:opacity-80";
const PANEL_CLS =
  "rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-3 mb-3";
const PANEL_TITLE_CLS = "text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2";
const LABEL_CLS = "flex flex-col gap-1 text-[11px] text-[var(--text-muted)]";
const ERR_CLS = "text-xs text-[var(--severity-error-fg)]";
const MONO_PRE_CLS =
  "font-mono text-[11px] leading-relaxed bg-[var(--bg-code)] border border-[var(--border-subtle)] " +
  "rounded p-2 max-h-[200px] overflow-auto text-[var(--text-primary)]";

interface Status {
  ok: boolean;
  state: string;
  pid: number | null;
  exitReason?: string;
  logs: string[];
}

async function getStatus(): Promise<Status> {
  const res = await fetch(`${API}/status`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as Status;
}

function StatePill({ state }: { state: string }) {
  const tone =
    state === "running"
      ? "bg-[var(--severity-success-bg)] border-[var(--severity-success-border)] text-[var(--severity-success-fg)]"
      : state === "stopped"
        ? "bg-[var(--severity-neutral-bg)] border-[var(--severity-neutral-border)] text-[var(--severity-neutral-fg)]"
        : "bg-[var(--severity-warning-bg)] border-[var(--severity-warning-border)] text-[var(--severity-warning-fg)]";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${tone}`}
    >
      {state}
    </span>
  );
}

export function Settings(_props: SlotProps<"settings-section">) {
  const config = usePluginConfig<Partial<MatrixBridgeConfig>>();
  const send = usePluginSend();

  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Connection form, seeded from persisted config.
  const [homeserverUrl, setHomeserverUrl] = useState(EMPTY_CONFIG.homeserverUrl);
  const [accessToken, setAccessToken] = useState(EMPTY_CONFIG.accessToken);
  const [encryption, setEncryption] = useState(EMPTY_CONFIG.encryption);
  const [autoConnect, setAutoConnect] = useState(EMPTY_CONFIG.autoConnect);
  const [workspace, setWorkspace] = useState("");

  // The persisted config is hydrated ASYNCHRONOUSLY (usePluginConfig reads an
  // empty value on first render, then `initPluginConfigs` populates it via a
  // post-render /api/config effect). The useState initializers above therefore
  // captured defaults on mount, before the real values arrived — so seed the
  // form once, the first time config carries any data. The ref keeps user
  // in-progress edits from being clobbered by later config noise.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    const hasData =
      !!config.homeserverUrl ||
      !!config.accessToken ||
      config.encryption != null ||
      config.autoConnect != null ||
      !!config.session?.workspace;
    if (!hasData) return;
    setHomeserverUrl(config.homeserverUrl ?? EMPTY_CONFIG.homeserverUrl);
    setAccessToken(config.accessToken ?? EMPTY_CONFIG.accessToken);
    setEncryption(config.encryption ?? EMPTY_CONFIG.encryption);
    setAutoConnect(config.autoConnect ?? EMPTY_CONFIG.autoConnect);
    setWorkspace(config.session?.workspace ?? "");
    hydratedRef.current = true;
  }, [config]);

  // Pairing.
  const [newUser, setNewUser] = useState("");
  const [pairError, setPairError] = useState<string | null>(null);
  const trustedUsers = useMemo(() => config.auth?.trustedUsers ?? [], [config.auth?.trustedUsers]);

  // Poll session status while the settings page is open.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await getStatus();
        if (!alive) return;
        setStatus(s);
        setStatusError(null);
      } catch (e) {
        if (!alive) return;
        setStatusError(e instanceof Error ? e.message : String(e));
        setStatus(null);
      }
    };
    void load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const persist = (next: Partial<MatrixBridgeConfig>) => {
    void send({
      type: "plugin_config_write",
      id: "pi-matrix-bridge",
      config: { ...config, ...next },
    });
  };

  const saveConnection = () => {
    persist({ homeserverUrl, accessToken, encryption, autoConnect, session: { workspace } });
  };

  const addUser = () => {
    const u = newUser.trim();
    if (!isUserMatrixId(u)) {
      setPairError(`Invalid user id "${u}" — expected e.g. @alice:example.org`);
      return;
    }
    setPairError(null);
    const users = trustedUsers.includes(u) ? trustedUsers : [...trustedUsers, u];
    persist({ auth: { trustedUsers: users } });
    setNewUser("");
  };

  const removeUser = (u: string) => {
    persist({ auth: { trustedUsers: trustedUsers.filter((x) => x !== u) } });
  };

  const post = (action: string) => void fetch(`${API}/${action}`, { method: "POST" });

  return (
    <div
      data-testid="pi-matrix-bridge-settings"
      className="space-y-3 text-sm text-[var(--text-primary)]"
    >
      {/* ── A. Matrix connection config ── */}
      <section data-testid="matrix-config" className={PANEL_CLS}>
        <h4 className={PANEL_TITLE_CLS}>Matrix 连接配置</h4>
        <div className="grid gap-2.5">
          <label className={LABEL_CLS}>
            Homeserver URL{" "}
            <input
              data-testid="homeserver-url"
              className={MONO_INPUT_CLS}
              value={homeserverUrl}
              onChange={(e) => setHomeserverUrl(e.target.value)}
              placeholder="https://matrix.example.org"
            />
          </label>
          <label className={LABEL_CLS}>
            Access Token{" "}
            <input
              data-testid="access-token"
              className={MONO_INPUT_CLS}
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
            />
          </label>
          <label className={LABEL_CLS}>
            Workspace（后台会话工作目录）{" "}
            <input
              data-testid="workspace"
              className={MONO_INPUT_CLS}
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="/path/to/workspace"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              data-testid="encryption"
              className="accent-blue-500"
              checked={encryption}
              onChange={(e) => setEncryption(e.target.checked)}
            />{" "}
            端到端加密 (E2EE)
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              data-testid="auto-connect"
              className="accent-blue-500"
              checked={autoConnect}
              onChange={(e) => setAutoConnect(e.target.checked)}
            />{" "}
            自动连接
          </label>
          <button data-testid="save-connection" className={BTN_PRIMARY} onClick={saveConnection}>
            保存连接配置
          </button>
        </div>
      </section>

      {/* ── B. Trusted-user pairing ── */}
      <section data-testid="pairing" className={PANEL_CLS}>
        <h4 className={PANEL_TITLE_CLS}>可信用户（配对）</h4>
        <div className="flex items-center gap-2">
          <input
            data-testid="trusted-user-input"
            className={MONO_INPUT_CLS}
            value={newUser}
            onChange={(e) => setNewUser(e.target.value)}
            placeholder="@alice:example.org"
          />
          <button data-testid="add-user" className={BTN_SECONDARY} onClick={addUser}>
            添加
          </button>
        </div>
        {pairError && (
          <div data-testid="pair-error" className={`${ERR_CLS} mt-1.5`}>
            {pairError}
          </div>
        )}
        {trustedUsers.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {trustedUsers.map((u) => (
              <li
                key={u}
                className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)]"
              >
                <code className="font-mono">{u}</code>{" "}
                <button data-testid={`remove-${u}`} className={BTN_DANGER} onClick={() => removeUser(u)}>
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── C. Session status ── */}
      <section data-testid="session-status" className={PANEL_CLS}>
        <div className="flex items-center justify-between mb-2">
          <h4 className={`${PANEL_TITLE_CLS} mb-0`}>会话状态</h4>
          {status && <StatePill state={status.state} />}
        </div>
        {statusError ? (
          <div data-testid="status-error" className={ERR_CLS}>
            状态获取失败: {statusError}
          </div>
        ) : status ? (
          <>
            <div className="text-xs text-[var(--text-secondary)]">
              状态: <strong data-testid="bridge-state" className="text-[var(--text-primary)]">{status.state}</strong>
              {status.pid != null ? ` (PID ${status.pid})` : ""}
            </div>
            {status.exitReason && (
              <div className="text-xs text-[var(--text-muted)]">原因: {status.exitReason}</div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <button data-testid="start-bridge" className={BTN_SECONDARY} onClick={() => post("start")}>
                启动
              </button>
              <button data-testid="stop-bridge" className={BTN_SECONDARY} onClick={() => post("stop")}>
                停止
              </button>
              <button data-testid="restart-bridge" className={BTN_SECONDARY} onClick={() => post("restart")}>
                重启
              </button>
            </div>
            <pre data-testid="bridge-logs" className={`${MONO_PRE_CLS} mt-2`}>
              {status.logs.join("\n")}
            </pre>
          </>
        ) : (
          <div className="text-xs text-[var(--text-muted)]">加载中…</div>
        )}
      </section>
    </div>
  );
}
