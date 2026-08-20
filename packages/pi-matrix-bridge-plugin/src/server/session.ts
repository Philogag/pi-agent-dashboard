import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { MatrixBridgeConfig, BridgeState } from "../types.js";

export interface SessionInfo {
  state: BridgeState;
  pid: number | null;
  exitReason?: string;
}

export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcess;

type Listener = (info: SessionInfo) => void;

const STOP_TIMEOUT_MS = 5000;
const MAX_LOG_LINES = 200;

/**
 * Manages the single background `pi` child process that drives the Matrix
 * bridge connection. Spawns `pi` in print mode, injects the bridge config via
 * env, and tracks a simple lifecycle state machine:
 *   stopped -> running; running -> (stop) stopping -> stopped; running -> exited.
 *
 * All lifecycle ops (start/stop/restart/detach) are serialized through a
 * single-flight promise chain so overlapping calls (e.g. concurrent REST
 * /start + /stop) cannot clobber `child`/`state` and orphan a live process.
 */
export class BackgroundSession {
  child: ChildProcess | null = null;
  state: BridgeState = "stopped";
  exitReason?: string;
  logs: string[] = [];

  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private cfg: () => MatrixBridgeConfig,
    private spawnImpl: SpawnImpl = spawn,
    private onState: Listener = () => {},
  ) {}

  /** Run a lifecycle op as the next link in the serialization chain. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn); // always run, even if prior op rejected
    this.queue = run.catch(() => {}); // chain continues after rejection
    return run;
  }

  info(): SessionInfo {
    return { state: this.state, pid: this.child?.pid ?? null, exitReason: this.exitReason };
  }

  private push(line: string): void {
    for (const raw of line.split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      this.logs.push(trimmed);
      if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
    }
  }

  private emit(): void {
    this.onState(this.info());
  }

  start(): Promise<{ ok: boolean; reason?: string }> {
    return this.serialize(() => this.startImpl());
  }

  private async startImpl(): Promise<{ ok: boolean; reason?: string }> {
    const { session, homeserverUrl, accessToken, autoConnect } = this.cfg();
    if (!homeserverUrl || !accessToken) {
      return { ok: false, reason: "matrix config incomplete" };
    }
    const workspace = session.workspace;
    if (workspace && !existsSync(workspace)) {
      return { ok: false, reason: `workspace not found: ${workspace}` };
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_MATRIX_BRIDGE_HOMESERVER: homeserverUrl,
      PI_MATRIX_BRIDGE_ACCESS_TOKEN: accessToken,
      PI_MATRIX_BRIDGE_AUTO_CONNECT: autoConnect ? "1" : "0",
    };

    // Guard against starting over a live child: tear it down first.
    if (this.child) {
      this.child.kill("SIGTERM");
    }
    this.state = "stopping";
    this.emit();

    const child = this.spawnImpl("pi", ["print"], { cwd: workspace || homedir(), env });
    this.child = child;
    this.state = "running";
    this.exitReason = undefined;

    child.stdout?.on("data", (d: Buffer | string) => this.push(d.toString()));
    child.stderr?.on("data", (d: Buffer | string) => this.push(d.toString()));
    child.on("exit", (code, sig) => {
      // Ignore stale exits from a child that has since been replaced (e.g. an old
      // child emitting a late exit after a restart). Only the active child drives state.
      if (this.child !== child) return;
      this.child = null;
      // stop() owns the transition to "stopped"; only non-initiated exits land here.
      if (this.state === "stopping") {
        this.state = "stopped";
        this.emit();
        return;
      }
      this.state = "exited";
      this.exitReason = `exit ${code ?? ""}${sig ? ` ${sig}` : ""}`;
      this.emit();
    });

    this.emit();
    return { ok: true };
  }

  stop(): Promise<void> {
    return this.serialize(() => this.stopImpl());
  }

  private async stopImpl(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      this.emit();
      return;
    }

    this.state = "stopping";
    this.emit();

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");

    const timedOut = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), STOP_TIMEOUT_MS);
      exited.then(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (timedOut) {
      child.kill("SIGKILL");
      await exited;
    }

    // Serialized: no other op can have replaced `child` while we awaited exit, so
    // it is still the child we stopped.
    this.child = null;
    this.state = "stopped";
    this.emit();
  }

  restart(): Promise<{ ok: boolean; reason?: string }> {
    return this.serialize(async () => {
      await this.stopImpl();
      return this.startImpl();
    });
  }

  detach(): Promise<void> {
    return this.serialize(() => this.detachImpl());
  }

  private async detachImpl(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timedOut = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), STOP_TIMEOUT_MS);
      exited.then(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (timedOut) child.kill("SIGKILL");
    this.child = null;
  }
}
