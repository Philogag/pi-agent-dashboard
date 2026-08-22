/**
 * ~/.pi/matrix-bridge.json adapter — the plugin's single source of truth for
 * connection + pairing config (native `pi-matrix-bridge` extension schema:
 * top-level `matrix` object + `auth.trustedUsers`/`auth.channels`).
 *
 * Reads the file into a boot-time snapshot, flattens it for the settings page,
 * and writes back the nested schema (matrix: prefix, channels preserved, 0600)
 * without touching the dashboard plugin store.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { matrixUserId } from "../types.js";

export const bridgeFilePath = () => join(homedir(), ".pi", "matrix-bridge.json");

export interface BridgeFileJson {
  matrix: { homeserverUrl: string; accessToken: string };
  auth: { trustedUsers: string[]; channels: Record<string, unknown> };
}

/** Read the native bridge file. Missing / unparsable / invalid shape → null (never throws). */
export async function readBridgeFile(
  target: string = bridgeFilePath(),
): Promise<BridgeFileJson | null> {
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = (parsed as { matrix?: unknown }).matrix;
  if (!m || typeof m !== "object") return null;
  const matrix = m as { homeserverUrl?: unknown; accessToken?: unknown };
  if (typeof matrix.homeserverUrl !== "string" || typeof matrix.accessToken !== "string") return null;
  const auth = ((parsed as { auth?: unknown }).auth ?? {}) as {
    trustedUsers?: unknown;
    channels?: unknown;
  };
  return {
    matrix: { homeserverUrl: matrix.homeserverUrl, accessToken: matrix.accessToken },
    auth: {
      trustedUsers: Array.isArray(auth.trustedUsers)
        ? auth.trustedUsers.filter((x): x is string => typeof x === "string")
        : [],
      channels: auth.channels && typeof auth.channels === "object" ? (auth.channels as Record<string, unknown>) : {},
    },
  };
}

export const stripMatrixPrefix = (id: string): string =>
  id.startsWith("matrix:") ? id.slice("matrix:".length) : id;

/** Flatten the native file into the settings-page view (matrix.* promoted, prefix stripped). */
export function flattenBridgeFile(
  file: BridgeFileJson | null,
): { homeserverUrl: string; accessToken: string; trustedUsers: string[] } {
  if (!file) return { homeserverUrl: "", accessToken: "", trustedUsers: [] };
  return {
    homeserverUrl: file.matrix.homeserverUrl,
    accessToken: file.matrix.accessToken,
    trustedUsers: file.auth.trustedUsers.map(stripMatrixPrefix),
  };
}

export class BridgeConfigError extends Error {}

export interface BridgeConfigInput {
  homeserverUrl: string;
  accessToken: string;
  trustedUsers: string[];
}

/** Write the native file: nested matrix.*, matrix: prefixed users, channels preserved, 0600. */
export async function writeBridgeConfig(
  input: BridgeConfigInput,
  target: string = bridgeFilePath(),
): Promise<BridgeFileJson> {
  const existing = await readBridgeFile(target);
  const hasConnection = Boolean(input.homeserverUrl || input.accessToken);
  if (!existing && !hasConnection) {
    throw new BridgeConfigError("connection config required when the bridge file does not exist");
  }
  let matrix = { homeserverUrl: input.homeserverUrl, accessToken: input.accessToken };
  if (!hasConnection && existing) matrix = existing.matrix;
  await mkdir(dirname(target), { recursive: true });
  const json: BridgeFileJson = {
    matrix,
    auth: {
      trustedUsers: input.trustedUsers.map(matrixUserId),
      channels: existing?.auth.channels ?? {},
    },
  };
  await writeFile(target, JSON.stringify(json, null, 2));
  await chmod(target, 0o600);
  return json;
}