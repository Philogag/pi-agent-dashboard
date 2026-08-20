import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MatrixBridgeConfig } from "../types.js";
import { matrixUserId } from "../types.js";

export const bridgeFilePath = () => join(homedir(), ".pi", "matrix-bridge.json");

export interface BridgeFileJson {
  homeserverUrl: string;
  accessToken: string;
  auth: { trustedUsers: string[] };
}

export function toBridgeFile(cfg: MatrixBridgeConfig): BridgeFileJson {
  return {
    homeserverUrl: cfg.homeserverUrl,
    accessToken: cfg.accessToken,
    auth: { trustedUsers: cfg.auth.trustedUsers.map(matrixUserId) },
  };
}

export function redact(cfg: MatrixBridgeConfig): string {
  return JSON.stringify({ ...toBridgeFile(cfg), accessToken: "***" }, null, 2);
}

export async function writeBridgeFile(
  cfg: MatrixBridgeConfig,
  target: string = bridgeFilePath()
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const data = JSON.stringify(toBridgeFile(cfg), null, 2);
  await writeFile(target, data);
  await chmod(target, 0o600);
}
