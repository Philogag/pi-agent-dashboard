import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { BackgroundSession } from "../../src/server/session.js";
import type { MatrixBridgeConfig, BridgeState } from "../../src/types.js";

const base: MatrixBridgeConfig = {
  homeserverUrl: "https://example.org",
  accessToken: "s3cret-token",
  encryption: true,
  autoConnect: true,
  session: { workspace: "" },
  auth: { trustedUsers: [] },
};

/** Minimal fake child_process.ChildProcess for tests: records kills and lets the test emit 'exit'. */
class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: NodeJS.Signals[] = [];
  constructor(
    public cmd: string,
    public args: string[],
    public opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) {
    super();
  }
  override kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit("exit", code, signal);
  }
}

type SpawnImpl = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => ChildProcess;

describe("BackgroundSession", () => {
  it("start() with a valid config spawns pi with bridge env and transitions to running", async () => {
    const invocations: Array<{
      cmd: string;
      args: string[];
      opts: { cwd?: string; env?: NodeJS.ProcessEnv };
    }> = [];
    let child: FakeChild | undefined;
    const spawnImpl: SpawnImpl = (cmd, args, opts) => {
      invocations.push({ cmd, args, opts });
      child = new FakeChild(cmd, args, opts);
      return child as unknown as ChildProcess;
    };

    const session = new BackgroundSession(() => base, spawnImpl);
    const res = await session.start();

    expect(res.ok).toBe(true);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].cmd).toBe("pi");
    expect(invocations[0].args).toEqual(["print"]);
    expect(invocations[0].opts).toEqual(
      expect.objectContaining({
        cwd: expect.any(String),
        env: expect.objectContaining({
          PI_MATRIX_BRIDGE_HOMESERVER: base.homeserverUrl,
          PI_MATRIX_BRIDGE_ACCESS_TOKEN: base.accessToken,
          PI_MATRIX_BRIDGE_AUTO_CONNECT: "1",
        }),
      }),
    );
    expect(session.state).toBe("running");
    expect(session.info().pid).toBe(child!.pid);
  });

  it("start() with an incomplete config returns ok:false and does not spawn", async () => {
    const spawnImpl = vi.fn<SpawnImpl>();
    const session = new BackgroundSession(
      () => ({ ...base, homeserverUrl: "", accessToken: "tok" }),
      spawnImpl as unknown as SpawnImpl,
    );
    const res = await session.start();

    expect(res.ok).toBe(false);
    expect(res.reason).toBeDefined();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(session.state).toBe("stopped");
  });

  it("start() with a missing workspace refuses to spawn with a workspace reason", async () => {
    const spawnImpl = vi.fn<SpawnImpl>();
    const missing = join(tmpdir(), "session-missing-workspace-" + Date.now());
    const session = new BackgroundSession(
      () => ({ ...base, session: { workspace: missing } }),
      spawnImpl as unknown as SpawnImpl,
    );
    const res = await session.start();

    expect(res.ok).toBe(false);
    expect(res.reason).toEqual(expect.stringMatching(/workspace/i));
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(session.state).toBe("stopped");
  });

  it("stop() sends SIGTERM and transitions stopping -> stopped", async () => {
    let child: FakeChild | undefined;
    const spawnImpl: SpawnImpl = (cmd, args, opts) => {
      child = new FakeChild(cmd, args, opts);
      return child as unknown as ChildProcess;
    };
    const states: BridgeState[] = [];
    const session = new BackgroundSession(() => base, spawnImpl, (info) => states.push(info.state));

    await session.start();
    states.length = 0;

    const stopP = session.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(session.state).toBe("stopping");
    expect(child!.killed).toEqual(["SIGTERM"]);

    child!.emitExit(0, null);
    await stopP;

    expect(session.state).toBe("stopped");
    expect(states).toContain("stopping");
    expect(states).toContain("stopped");
  });

  it("a child 'exit' event sets state to exited and records exitReason", async () => {
    let child!: FakeChild;
    const spawnImpl: SpawnImpl = (cmd, args, opts) => {
      child = new FakeChild(cmd, args, opts);
      return child as unknown as ChildProcess;
    };
    const session = new BackgroundSession(() => base, spawnImpl);

    await session.start();
    expect(session.state).toBe("running");

    child.emitExit(1, "SIGKILL");
    expect(session.state).toBe("exited");
    expect(session.exitReason).toContain("1");
    expect(session.info().state).toBe("exited");
  });

  it("restart() stops the old child then starts again with the latest config", async () => {
    const children: FakeChild[] = [];
    const spawnImpl: SpawnImpl = (cmd, args, opts) => {
      const c = new FakeChild(cmd, args, opts);
      children.push(c);
      return c as unknown as ChildProcess;
    };
    let cfg = { ...base, homeserverUrl: "https://a.example" };
    const session = new BackgroundSession(() => cfg, spawnImpl);

    await session.start();
    expect(children).toHaveLength(1);

    cfg = { ...base, homeserverUrl: "https://b.example" };
    const prev = children[0];
    prev.kill = (sig) => {
      queueMicrotask(() => prev.emitExit(0, null));
      return true;
    };

    const res = await session.restart();
    expect(res.ok).toBe(true);
    expect(children).toHaveLength(2);
    expect(session.state).toBe("running");
    expect(session.info().pid).toBe(children[1].pid);
    expect(children[1].opts.env?.["PI_MATRIX_BRIDGE_HOMESERVER"]).toBe("https://b.example");
  });

  it("serializes overlapping start() calls: last child wins, stale exit is ignored", async () => {
    const children: FakeChild[] = [];
    const spawnImpl: SpawnImpl = (cmd, args, opts) => {
      const c = new FakeChild(cmd, args, opts);
      children.push(c);
      // Realistic teardown: a kill records the signal and eventually produces an exit asynchronously.
      c.kill = (sig) => {
        c.killed.push(sig ?? "SIGTERM");
        queueMicrotask(() => c.emitExit(0, null));
        return true;
      };
      return c as unknown as ChildProcess;
    };
    const session = new BackgroundSession(() => base, spawnImpl);

    const [r1, r2] = await Promise.all([session.start(), session.start()]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(children).toHaveLength(2); // serialized: second start replaced the first
    expect(session.state).toBe("running");
    expect(session.child).toBe(children[1]); // active child is the LAST spawn
    expect(session.info().pid).toBe(children[1].pid);
    expect(children[0].killed).toContain("SIGTERM");

    // The first (replaced) child's dequeued exit must NOT reset the live state.
    children[0].emitExit(0, null);
    expect(session.state).toBe("running");
    expect(session.child).toBe(children[1]);
  });
});
