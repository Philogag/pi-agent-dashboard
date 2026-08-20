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
 */
import { useEffect, useMemo, useState } from "react";
import {
  usePluginConfig,
  usePluginSend,
} from "@blackbelt-technology/dashboard-plugin-runtime/context";
import type { SlotProps } from "@blackbelt-technology/pi-dashboard-shared/dashboard-plugin/slot-props.js";
import { EMPTY_CONFIG, isUserMatrixId, type MatrixBridgeConfig } from "./types.js";

const API = "/api/pi-matrix-bridge";

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

export function Settings(_props: SlotProps<"settings-section">) {
  const config = usePluginConfig<Partial<MatrixBridgeConfig>>();
  const send = usePluginSend();

  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Connection form, seeded from persisted config.
  const [homeserverUrl, setHomeserverUrl] = useState(config.homeserverUrl ?? EMPTY_CONFIG.homeserverUrl);
  const [accessToken, setAccessToken] = useState(config.accessToken ?? EMPTY_CONFIG.accessToken);
  const [encryption, setEncryption] = useState(config.encryption ?? EMPTY_CONFIG.encryption);
  const [autoConnect, setAutoConnect] = useState(config.autoConnect ?? EMPTY_CONFIG.autoConnect);
  const [workspace, setWorkspace] = useState(config.session?.workspace ?? "");

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
    <div data-testid="pi-matrix-bridge-settings" style={{ padding: "8px" }}>
      <h3>Pi Matrix Bridge</h3>

      <section data-testid="matrix-config" style={{ marginBottom: "16px" }}>
        <h4>Matrix 连接配置</h4>
        <div style={{ display: "grid", gap: "8px" }}>
          <label>
            Homeserver URL{" "}
            <input
              data-testid="homeserver-url"
              value={homeserverUrl}
              onChange={(e) => setHomeserverUrl(e.target.value)}
              placeholder="https://matrix.example.org"
            />
          </label>
          <label>
            Access Token{" "}
            <input
              data-testid="access-token"
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
            />
          </label>
          <label>
            Workspace（后台会话工作目录）{" "}
            <input
              data-testid="workspace"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="/path/to/workspace"
            />
          </label>
          <label>
            <input
              type="checkbox"
              data-testid="encryption"
              checked={encryption}
              onChange={(e) => setEncryption(e.target.checked)}
            />{" "}
            端到端加密 (E2EE)
          </label>
          <label>
            <input
              type="checkbox"
              data-testid="auto-connect"
              checked={autoConnect}
              onChange={(e) => setAutoConnect(e.target.checked)}
            />{" "}
            自动连接
          </label>
          <button data-testid="save-connection" onClick={saveConnection}>
            保存连接配置
          </button>
        </div>
      </section>

      <section data-testid="pairing" style={{ marginBottom: "16px" }}>
        <h4>可信用户（配对）</h4>
        <input
          data-testid="trusted-user-input"
          value={newUser}
          onChange={(e) => setNewUser(e.target.value)}
          placeholder="@alice:example.org"
        />{" "}
        <button data-testid="add-user" onClick={addUser}>
          添加
        </button>
        {pairError && (
          <div data-testid="pair-error" style={{ color: "red" }}>
            {pairError}
          </div>
        )}
        <ul>
          {trustedUsers.map((u) => (
            <li key={u}>
              {u}{" "}
              <button data-testid={`remove-${u}`} onClick={() => removeUser(u)}>
                移除
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section data-testid="session-status">
        <h4>会话状态</h4>
        {statusError ? (
          <div data-testid="status-error" style={{ color: "red" }}>
            状态获取失败: {statusError}
          </div>
        ) : status ? (
          <>
            <div>
              状态: <strong data-testid="bridge-state">{status.state}</strong>
              {status.pid != null ? ` (PID ${status.pid})` : ""}
            </div>
            {status.exitReason && <div>原因: {status.exitReason}</div>}
            <div style={{ marginTop: "8px" }}>
              <button data-testid="start-bridge" onClick={() => post("start")}>
                启动
              </button>{" "}
              <button data-testid="stop-bridge" onClick={() => post("stop")}>
                停止
              </button>{" "}
              <button data-testid="restart-bridge" onClick={() => post("restart")}>
                重启
              </button>
            </div>
            <pre
              data-testid="bridge-logs"
              style={{ fontSize: "11px", maxHeight: "200px", overflow: "auto" }}
            >
              {status.logs.join("\n")}
            </pre>
          </>
        ) : (
          <div>加载中…</div>
        )}
      </section>
    </div>
  );
}
