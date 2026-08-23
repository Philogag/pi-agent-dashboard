import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { notifyMatrixUser } from "./matrix-notify.js";
import type { BackgroundSession } from "./session.js";

export interface ConnectControllerOptions {
  homeserverUrl?: string;
  accessToken?: string;
  /** Paired users (@user:server, prefix optional) to DM after connecting. */
  trustedUsers?: string[];
  /** Lock file the extension writes once connected (~/.pi/matrix-bridge.lock). */
  lockPath?: string;
  lockPollMs?: number;
  lockTimeoutMs?: number;
  /** Text DM'd to trusted users after a confirmed connection. */
  notifyText?: string;
  initPrompt?: string;
  logger?: { warn: (msg: string) => void };
}

export const DEFAULT_INIT_PROMPT = "【连接测试】Matrix 桥已连接。请回复一句简短的测试消息确认链路正常。";
const DEFAULT_NOTIFY_TEXT = "✅ Matrix 桥已连接";
const DEFAULT_LOCK_POLL_MS = 250;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

export function defaultLockPath(): string {
  return `${homedir()}/.pi/matrix-bridge.lock`;
}

/** Poll for the extension's lock file; true as soon as it appears. */
export async function waitForLock(path: string, pollMs: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) return true;
    if (Date.now() >= deadline) return existsSync(path);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Drive the background pi session (rpc mode) through its boot sequence:
 *
 *   1. `/matrix-bridge connect` on stdin — connects the extension's transports
 *      (the sessions are spawned with no PI_MATRIX_BRIDGE_* env, so nothing
 *      auto-connects; the RPC command is the single source of connection).
 *   2. Wait for ~/.pi/matrix-bridge.lock to appear (extension writes it on a
 *      successful acquireLock) — the connected signal. On timeout: warn, but
 *      still proceed with the init prompt + a warning DM.
 *   3. Push the init test prompt on stdin so the agent replies with a test
 *      message (no transport attribution → not forwarded to Matrix).
 *   4. DM each trusted user directly via matrix-bot-sdk (REST, best-effort).
 *
 * Never throws — every failure path degrades to a logger.warn.
 */
export async function runConnectController(
  session: BackgroundSession,
  opts: ConnectControllerOptions,
): Promise<void> {
  const warn = opts.logger?.warn ?? (() => {});
  const lockPath = opts.lockPath ?? defaultLockPath();
  const pollMs = opts.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  const timeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  session.sendRpc("/matrix-bridge connect", "matrix-connect");

  const connected = await waitForLock(lockPath, pollMs, timeoutMs);
  const text = connected
    ? (opts.notifyText ?? DEFAULT_NOTIFY_TEXT)
    : "⚠️ Matrix 桥未能在超时内确认连接，请检查后台会话日志。";
  if (!connected) {
    warn(`matrix bridge did not report connected within ${timeoutMs}ms (lock ${lockPath})`);
  }
  session.sendRpc(opts.initPrompt ?? DEFAULT_INIT_PROMPT, "matrix-init-prompt");

  const { homeserverUrl, accessToken } = opts;
  if (!homeserverUrl || !accessToken) return;
  for (const user of opts.trustedUsers ?? []) {
    const ok = await notifyMatrixUser({ homeserverUrl, accessToken, userId: user, text });
    if (!ok) warn(`matrix notice to ${user} failed`);
  }
}