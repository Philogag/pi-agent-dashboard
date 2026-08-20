export interface MatrixBridgeConfig {
  homeserverUrl: string;
  accessToken: string;
  encryption: boolean;
  autoConnect: boolean;
  session: { workspace: string };
  auth: { trustedUsers: string[] }; // stores @user:server (no matrix: prefix); prefix added on mirror
}

export type BridgeState = "stopped" | "running" | "stopping" | "exited";

export const EMPTY_CONFIG: MatrixBridgeConfig = {
  homeserverUrl: "",
  accessToken: "",
  encryption: true,
  autoConnect: true,
  session: { workspace: "" },
  auth: { trustedUsers: [] },
};

export const isUserMatrixId = (s: string) => /^@[^:]+:.+$/.test(s);

export const matrixUserId = (s: string) => `matrix:${s}`;
