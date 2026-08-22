---
change: matrix-bridge-config-import-mirror-fix
design-doc: openspec/changes/matrix-bridge-config-import-mirror-fix/superpower-design.md
base-ref: b5269f7014378b7fe13fa5f9e25bcbe342b1ea33
---

# Matrix Bridge Native-File Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让 `~/.pi/matrix-bridge.json`（bridge 原生文件）成为连接+配对的唯一配置源：设置页经 `GET`/`POST /api/pi-matrix-bridge/config` 直接读写该文件；删除镜像机制；插件存储瘦身为会话侧字段。

**Architecture:** 注册期 `readBridgeFile()` 一次读文件进内存快照（`let fileValues`）→ 同步 `effective()` getter = 快照连接 + `readConfig()` 存储会话侧字段 → `BackgroundSession(effective, ...)`（session.ts 零改动）。`mirror.ts` 更名 `bridge-file.ts` 为原生文件适配器（读快照 / 展平视图 / 嵌套写入）。保存经 `POST /config` 写文件并刷新快照。

**Tech Stack:** TypeScript, vitest 4, fastify 5, React 19, @blackbelt-technology/dashboard-plugin-runtime ^0.7.0。

**Spec:** `openspec/changes/matrix-bridge-config-import-mirror-fix/{proposal.md, design.md, specs/matrix-bridge-plugin/spec.md, superpower-design.md}`。

## Global Constraints

- 连接+配对配置只存在于 `~/.pi/matrix-bridge.json`；插件存储不持久化连接/配对（用户决策）。
- 文件 schema 与上游扩展兼容：顶层 `matrix.{homeserverUrl,accessToken}` + `auth.{trustedUsers,channels}`；`auth.channels` 写入前读-改-写合并保留；权限 600；`matrix:` 前缀只在文件侧。
- `plugin_config_write` 仅用于会话侧字段（workspace/autoConnect/encryption）。
- 文件缺失/无效 MUST 静默降级（空表单、不自动启动、不报错）。
- 测试先红后绿；每任务独立提交；包内测试 `cd packages/pi-matrix-bridge-plugin && npx vitest run <file>`。
- 不使用 `as any`；风格沿用现有（前置注释、`node:fs/promises`、vitest）。

---

### Task 1: 原生文件适配器 — `bridge-file.ts`（mirror.ts 更名改写）

**Files:**
- Rename: `packages/pi-matrix-bridge-plugin/src/server/mirror.ts` → `src/server/bridge-file.ts`
- Rename: `packages/pi-matrix-bridge-plugin/test/unit/mirror.test.ts` → `test/unit/bridge-file.test.ts`
- Modify: `packages/pi-matrix-bridge-plugin/AGENTS.md`（m00154 之后改行：mirror.ts → bridge-file.ts；见 Task 5 亦可一并做——先改本仓库行避免遗漏）

**Interfaces (Produces):**
- `interface BridgeFileJson { matrix: { homeserverUrl: string; accessToken: string }; auth: { trustedUsers: string[]; channels: Record<string, unknown> } }`
- `readBridgeFile(target?): Promise<BridgeFileJson | null>` — 缺失/损坏/无效 → `null`，不抛
- `flattenBridgeFile(file: BridgeFileJson | null): { homeserverUrl: string; accessToken: string; trustedUsers: string[] }`
- `stripMatrixPrefix(id: string): string`
- `class BridgeConfigError extends Error`
- `writeBridgeConfig(input: { homeserverUrl: string; accessToken: string; trustedUsers: string[] }, target?): Promise<BridgeFileJson>` — 嵌套写出、前缀、channels 合并、0600、mkdir；无文件且连接全空 → `BridgeConfigError`

- [ ] **Step 1: 更名并重写测试（红）**

```bash
cd packages/pi-matrix-bridge-plugin
git mv src/server/mirror.ts src/server/bridge-file.ts
git mv test/unit/mirror.test.ts test/unit/bridge-file.test.ts
```

`test/unit/bridge-file.test.ts` 全文（`writeBridgeFile/toBridgeFile/redact` 引用替换为新适配器 API）：

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBridgeFile,
  flattenBridgeFile,
  stripMatrixPrefix,
  writeBridgeConfig,
  BridgeConfigError,
  type BridgeFileJson,
} from "../../src/server/bridge-file.js";

let tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-file-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

const input = { homeserverUrl: "https://example.org", accessToken: "s3cret-token", trustedUsers: ["@alice:example.org"] };

describe("bridge-file adapter (~/.pi/matrix-bridge.json)", () => {
  it("readBridgeFile parses the native nested schema", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "matrix-bridge.json");
    await writeFile(target, JSON.stringify({
      matrix: { homeserverUrl: "https://example.org", accessToken: "s3cret-token" },
      auth: { trustedUsers: ["matrix:@alice:example.org"], channels: { "!room:server": "allow" } },
    }), "utf8");
    const file = await readBridgeFile(target);
    expect(file).toEqual({
      matrix: { homeserverUrl: "https://example.org", accessToken: "s3cret-token" },
      auth: { trustedUsers: ["matrix:@alice:example.org"], channels: { "!room:server": "allow" } },
    });
  });

  it("readBridgeFile returns null for missing / broken / invalid files", async () => {
    expect(await readBridgeFile("/nonexistent/definitely-missing.json")).toBeNull();
    const dir = await makeTmpDir();
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{not json", "utf8");
    expect(await readBridgeFile(bad)).toBeNull();
    const noMatrix = join(dir, "nomatrix.json");
    await writeFile(noMatrix, JSON.stringify({ auth: { trustedUsers: [] } }), "utf8");
    expect(await readBridgeFile(noMatrix)).toBeNull();
  });

  it("stripMatrixPrefix strips only the matrix: namespace prefix", () => {
    expect(stripMatrixPrefix("matrix:@alice:example.org")).toBe("@alice:example.org");
    expect(stripMatrixPrefix("@bob:example.org")).toBe("@bob:example.org");
  });

  it("flattenBridgeFile flattens matrix.* and strips prefixes; null → empty defaults", () => {
    const file: BridgeFileJson = {
      matrix: { homeserverUrl: "https://example.org", accessToken: "s3cret-token" },
      auth: { trustedUsers: ["matrix:@alice:example.org", "@raw:other.org"], channels: {} },
    };
    expect(flattenBridgeFile(file)).toEqual({
      homeserverUrl: "https://example.org",
      accessToken: "s3cret-token",
      trustedUsers: ["@alice:example.org", "@raw:other.org"],
    });
    expect(flattenBridgeFile(null)).toEqual({ homeserverUrl: "", accessToken: "", trustedUsers: [] });
  });

  it("writeBridgeConfig writes nested matrix.* with matrix: prefixed users and mode 0o600", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "matrix-bridge.json");
    const written = await writeBridgeConfig(input, target);
    expect(written.matrix).toEqual({ homeserverUrl: "https://example.org", accessToken: "s3cret-token" });
    const parsed = JSON.parse(await readFile(target, "utf8"));
    expect(parsed.matrix).toEqual({ homeserverUrl: "https://example.org", accessToken: "s3cret-token" });
    expect(parsed.auth.trustedUsers).toEqual(["matrix:@alice:example.org"]);
    const { mode } = await stat(target);
    expect(mode & 0o777).toBe(0o600);
  });

  it("writeBridgeConfig preserves existing auth.channels (read-modify-write)", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "matrix-bridge.json");
    await writeFile(target, JSON.stringify({
      matrix: { homeserverUrl: "https://old.example.org", accessToken: "old-token" },
      auth: { trustedUsers: ["matrix:@bob:example.org"], channels: { "!room:server": "allow" } },
    }), "utf8");
    await writeBridgeConfig(input, target);
    const parsed = JSON.parse(await readFile(target, "utf8"));
    expect(parsed.matrix).toEqual({ homeserverUrl: "https://example.org", accessToken: "s3cret-token" });
    expect(parsed.auth.channels).toEqual({ "!room:server": "allow" });
  });

  it("writeBridgeConfig auto-creates nested parent directories", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "nested", "deep", "matrix-bridge.json");
    await writeBridgeConfig(input, target);
    expect((await readFile(target, "utf8")).length).toBeGreaterThan(0);
  });

  it("writeBridgeConfig throws BridgeConfigError when no file and no connection (E10)", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "matrix-bridge.json");
    await expect(writeBridgeConfig({ homeserverUrl: "", accessToken: "", trustedUsers: [] }, target))
      .rejects.toBeInstanceOf(BridgeConfigError);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/pi-matrix-bridge-plugin && npx vitest run test/unit/bridge-file.test.ts`
Expected: FAIL（`flattenBridgeFile`/`writeBridgeConfig`/`BridgeConfigError` 不存在；旧 `writeBridgeFile` 导入失败）。

- [ ] **Step 3: 实现 `src/server/bridge-file.ts`（全文覆写）**

```ts
/**
 * ~/.pi/matrix-bridge.json adapter — the plugin's single source of truth for
 * connection + pairing config (native `pi-matrix-bridge` extension schema:
 * top-level `matrix` object + `auth.trustedUsers`/`auth.channels`).
 *
 * Reads the file into a boot-time snapshot, flattens it for the settings page,
 * and writes back the nested schema (matrix: prefix, channels preserved, 0600)
 * without touching the dashboard plugin store.
 */
import { mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
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
  const auth = ((parsed as { auth?: unknown }).auth ?? {}) as { trustedUsers?: unknown; channels?: unknown };
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
  const matrix = hasConnection
    ? { homeserverUrl: input.homeserverUrl, accessToken: input.accessToken }
    : existing!.matrix;
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
```
  注：`existing!.matrix` 分支仅在 `hasConnection=false` 且 `existing` 非空时可达 —— 若团队风格禁止 `!`，改写为：
```ts
  let matrix = { homeserverUrl: input.homeserverUrl, accessToken: input.accessToken };
  if (!hasConnection && existing) matrix = existing.matrix;
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/pi-matrix-bridge-plugin && npx vitest run test/unit/bridge-file.test.ts`
Expected: PASS。

- [ ] **Step 5: 更新 AGENTS.md 行 + Commit**

`packages/pi-matrix-bridge-plugin/AGENTS.md`：将 `src/server/mirror.ts` 行改为 `| src/server/bridge-file.ts | native bridge-file adapter: readBridgeFile / flattenBridgeFile / writeBridgeConfig / stripMatrixPrefix — single source of truth for connection+pairing config |`（测试行 `test/unit/mirror.test.ts` → `test/unit/bridge-file.test.ts`）。
```bash
git add packages/pi-matrix-bridge-plugin/src/server/bridge-file.ts packages/pi-matrix-bridge-plugin/test/unit/bridge-file.test.ts packages/pi-matrix-bridge-plugin/AGENTS.md
git commit -m "feat(pi-matrix-bridge): native bridge-file adapter (read/flatten/write)"
```

---

### Task 2: 注册期快照 + 删除镜像 + `effective()` 会话配置（index.ts + server.test.ts 注册断言）

**Files:**
- Modify: `packages/pi-matrix-bridge-plugin/src/server/index.ts`
- Modify: `packages/pi-matrix-bridge-plugin/test/unit/server.test.ts`

**Interfaces:**
- Consumes: `readBridgeFile`, `flattenBridgeFile`, `bridgeFilePath`（Task 1）
- Produces: `effective(): MatrixBridgeConfig`（快照连接 + 存储会话侧，trustedUsers 去重）— `BackgroundSession` 读取器与自动启动判定的唯一输入

- [ ] **Step 1: 更新 server.test.ts 注册断言（红）**

`makeCtx` 增可选 fastify 覆写参；`ServerBridgeOptions` 改 `{ filePath, spawnImpl }`：
```ts
function makeCtx(config: Record<string, unknown>, fastifyOverride?: unknown): { ctx: ServerPluginContext; state: CtxState } {
  ...
    fastify: fastifyOverride ?? { register: ..., },
```
  「registers REST prefix + replay handler and mirrors…」用例改为（删镜像断言，加「无文件不写文件」）：
```ts
  it("registers REST prefix + replay browser handler; no bridge file created without config", async () => {
    const { ctx, state } = makeCtx({ enabled: true });
    const dir = mkdtempSync(join(tmpdir(), "mbr-boot-"));
    const target = join(dir, "matrix-bridge.json");
    await registerPlugin(ctx, { filePath: target, spawnImpl: () => fakeChild() as never });
    expect(state.registerPrefix).toBe("/api/pi-matrix-bridge");
    expect(state.browserHandlers).toContain("pi-matrix-bridge_status_replay");
    expect(existsSync(target)).toBe(false); // no mirror write anymore
    expect(state.broadcasts.some((b) => (b as { type?: string }).type === "pi-matrix-bridge_status")).toBe(true);
  });
```
  自动启动用例改为文件驱动（红：当前实现读不到文件）：
```ts
  it("auto-starts from the native bridge file when store has no connection fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-boot-"));
    const target = join(dir, "matrix-bridge.json");
    writeFileSync(target, JSON.stringify({
      matrix: { homeserverUrl: "https://file.example.org", accessToken: "syt_file_token" },
      auth: { trustedUsers: ["matrix:@alice:example.org"], channels: { "!room:server": "allow" } },
    }));
    const { ctx, state } = makeCtx({ enabled: true, autoConnect: true, session: {}, auth: { trustedUsers: [] } });
    await registerPlugin(ctx, {
      filePath: target,
      spawnImpl: (_cmd, _args, opts) => {
        state.spawnCalls += 1;
        state.lastSpawn = opts;
        return fakeChild() as never;
      },
    });
    expect(state.spawnCalls).toBe(1);
    const env = (state.lastSpawn as { env?: Record<string, string> })?.env ?? {};
    expect(env.PI_MATRIX_BRIDGE_HOMESERVER).toBe("https://file.example.org");
    expect(env.PI_MATRIX_BRIDGE_ACCESS_TOKEN).toBe("syt_file_token");
  });

  it("does not auto-start without a usable bridge file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-boot-"));
    const target = join(dir, "matrix-bridge.json"); // never created
    const { ctx, state } = makeCtx({ enabled: true, autoConnect: true, session: {}, auth: { trustedUsers: [] } });
    await registerPlugin(ctx, { filePath: target, spawnImpl: () => { state.spawnCalls += 1; return fakeChild() as never; } });
    expect(state.spawnCalls).toBe(0);
  });
```
  注：其余 `mirrorTarget` 引用全部改 `filePath`；转发（onEvent）两用例的 store `auth.trustedUsers` 保持（effective 合并后 gate 仍过）。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/pi-matrix-bridge-plugin && npx vitest run test/unit/server.test.ts`
Expected: FAIL（快照未实现 → 无 spawn；`mirrorTarget` 类型报错）。

- [ ] **Step 3: 实现 index.ts**

头部 docstring「mirrored to ~/.pi/matrix-bridge.json」改为「native config file is the single source of truth for connection/pairing; dashboard store holds session-side fields only」。导入：
```ts
import { BackgroundSession, type SpawnImpl } from "./session.js";
import { readBridgeFile, flattenBridgeFile, bridgeFilePath } from "./bridge-file.js";
import type { MatrixBridgeConfig } from "../types.js";
```
`ServerBridgeOptions`：
```ts
export interface ServerBridgeOptions {
  spawnImpl?: SpawnImpl;
  filePath?: string; // test seam: bridge-file path (defaults to ~/.pi/matrix-bridge.json)
}
```
删除常量 `MIRROR_ERROR_TYPE`。`registerPlugin` 内（`readConfig` 定义之后，`bridge` 构造之前）：
```ts
  // Boot-time snapshot of the native bridge file — the single source of truth
  // for connection + pairing. Never persisted into the plugin store (D1).
  let fileValues = await readBridgeFile(opts.filePath ?? bridgeFilePath());
  const effective = (): MatrixBridgeConfig => {
    const store = readConfig();
    const flat = flattenBridgeFile(fileValues);
    return {
      ...store,
      homeserverUrl: flat.homeserverUrl,
      accessToken: flat.accessToken,
      auth: {
        ...store.auth,
        trustedUsers: Array.from(new Set([...store.auth.trustedUsers, ...flat.trustedUsers])),
      },
    };
  };
```
  删除 `runMirror` 定义与注册期调用、启停动作中的调用；`bridge` 构造改传 `effective`；自动启动：
```ts
  const initial = effective();
  if (initial.autoConnect && initial.homeserverUrl && initial.accessToken) {
    const res = await bridge.start();
    if (!res.ok) ctx.logger.warn(`matrix-bridge auto-start skipped: ${res.reason}`);
  }
```
  转发门改 `effective().auth?.trustedUsers?.length ?? 0`。文件头部 import 移除 `writeBridgeFile`。

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/pi-matrix-bridge-plugin && npx vitest run test/unit/server.test.ts test/unit/session.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/pi-matrix-bridge-plugin/src/server/index.ts packages/pi-matrix-bridge-plugin/test/unit/server.test.ts
git commit -m "feat(pi-matrix-bridge): boot-time bridge-file snapshot + effective() session config"
```

---

### Task 3: `GET`/`POST /api/pi-matrix-bridge/config` 端点

**Files:**
- Modify: `packages/pi-matrix-bridge-plugin/src/server/index.ts`
- Modify: `packages/pi-matrix-bridge-plugin/test/unit/server.test.ts`

**Interfaces (Produces):**
- `GET /config` → `{ ok: true, ...effective() }`（扁平视图见 Task 2）
- `POST /config` body `{ homeserverUrl, accessToken, trustedUsers }` → 200 `{ ok: true, ...effective() }`（fileValues 已刷新）；400 `{ ok: false, error }`（`BridgeConfigError`）；500 `{ ok: false, error }`（写盘失败）

- [ ] **Step 1: 新增 real-fastify 用例（红）**

`server.test.ts` 增加 `import Fastify from "fastify";`，用例：
```ts
  it("GET /config returns the flattened file view when the store is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-cfg-"));
    const target = join(dir, "matrix-bridge.json");
    writeFileSync(target, JSON.stringify({
      matrix: { homeserverUrl: "https://file.example.org", accessToken: "syt_file_token" },
      auth: { trustedUsers: ["matrix:@alice:example.org"], channels: { "!room:server": "allow" } },
    }));
    const app = Fastify();
    const { ctx } = makeCtx({ enabled: true, autoConnect: true, session: {}, auth: { trustedUsers: [] } }, app);
    await registerPlugin(ctx, { filePath: target, spawnImpl: () => fakeChild() as never });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/pi-matrix-bridge/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.homeserverUrl).toBe("https://file.example.org");
    expect(body.accessToken).toBe("syt_file_token");
    expect(body.auth.trustedUsers).toEqual(["@alice:example.org"]); // prefix stripped in view
    expect(body.autoConnect).toBe(true); // session-side comes from store defaults
  });

  it("POST /config writes the native file, refreshes the snapshot, preserves channels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-cfg-"));
    const target = join(dir, "matrix-bridge.json");
    writeFileSync(target, JSON.stringify({
      matrix: { homeserverUrl: "https://old.example.org", accessToken: "old-token" },
      auth: { trustedUsers: ["matrix:@bob:example.org"], channels: { "!room:server": "allow" } },
    }));
    const app = Fastify();
    const { ctx } = makeCtx({ enabled: true, autoConnect: true, session: {}, auth: { trustedUsers: [] } }, app);
    await registerPlugin(ctx, { filePath: target, spawnImpl: () => fakeChild() as never });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/pi-matrix-bridge/config",
      payload: { homeserverUrl: "https://new.example.org", accessToken: "new-token", trustedUsers: ["@alice:example.org"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().homeserverUrl).toBe("https://new.example.org");
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.matrix).toEqual({ homeserverUrl: "https://new.example.org", accessToken: "new-token" });
    expect(parsed.auth.trustedUsers).toEqual(["matrix:@alice:example.org"]);
    expect(parsed.auth.channels).toEqual({ "!room:server": "allow" });
    // snapshot refreshed: subsequent GET sees the new values
    const after = await app.inject({ method: "GET", url: "/api/pi-matrix-bridge/config" });
    expect(after.json().homeserverUrl).toBe("https://new.example.org");
  });

  it("POST /config rejects empty connection when no file exists (E10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbr-cfg-"));
    const target = join(dir, "matrix-bridge.json");
    const app = Fastify();
    const { ctx } = makeCtx({ enabled: true }, app);
    await registerPlugin(ctx, { filePath: target, spawnImpl: () => fakeChild() as never });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/pi-matrix-bridge/config",
      payload: { homeserverUrl: "", accessToken: "", trustedUsers: [] },
    });
    expect(res.statusCode).toBe(400);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/pi-matrix-bridge-plugin && npx vitest run test/unit/server.test.ts`
Expected: 新用例 FAIL（404 无路由）。

- [ ] **Step 3: 实现端点**

`ctx.fastify.register(async (r) => { ... })` 内新增（`r.get("/status", ...)` 旁）：
```ts
      r.get("/config", async () => ({ ok: true, ...effective() }));
      r.post("/config", async (req, reply) => {
        const body = (req.body ?? {}) as {
          homeserverUrl?: string;
          accessToken?: string;
          trustedUsers?: string[];
        };
        try {
          await writeBridgeConfig(
            {
              homeserverUrl: body.homeserverUrl ?? "",
              accessToken: body.accessToken ?? "",
              trustedUsers: body.trustedUsers ?? [],
            },
            opts.filePath ?? bridgeFilePath(),
          );
          fileValues = await readBridgeFile(opts.filePath ?? bridgeFilePath());
          return { ok: true, ...effective() };
        } catch (err) {
          if (err instanceof BridgeConfigError) {
            return reply.code(400).send({ ok: false, error: err.message });
          }
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(`matrix-bridge config write failed: ${message}`);
          return reply.code(500).send({ ok: false, error: "failed to write bridge config" });
        }
      });
```
  导入补充：`import { ..., writeBridgeConfig, BridgeConfigError } from "./bridge-file.js";`
  注：`writeBridgeConfig` 返回的 json 亦可直接赋 `fileValues = written` —— 二选一，取 re-read（更贴近真实文件状态）。

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/pi-matrix-bridge-plugin && npx vitest run test/unit/server.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/pi-matrix-bridge-plugin/src/server/index.ts packages/pi-matrix-bridge-plugin/test/unit/server.test.ts
git commit -m "feat(pi-matrix-bridge): GET/POST /config endpoints for native bridge file"
```

---

### Task 4: 插件存储瘦身 + 客户端绑定 `/config`

**Files:**
- Modify: `packages/pi-matrix-bridge-plugin/src/client.tsx`
- Modify: `packages/pi-matrix-bridge-plugin/configSchema.json`
- Modify: `packages/pi-matrix-bridge-plugin/test/unit/client.test.tsx`

**Interfaces:**
- Consumes: `GET`/`POST /api/pi-matrix-bridge/config`（Task 3）；`usePluginConfig` 仅会话侧
- Produces: 表单连接/配对绑定 `conn` state；`plugin_config_write` 仅发 `{autoConnect, encryption, session:{workspace}}`

- [ ] **Step 1: 更新 client.test.tsx（红）**

fetch mock 改为按 URL 路由：
```tsx
const routes: Record<string, unknown> = {};
function mockFetch(map: Record<string, unknown>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const key = init?.method === "POST" ? `${url}:POST` : url;
    const value = map[key] ?? map[url] ?? { ok: true, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => value } as unknown as Response;
  }) as unknown as typeof fetch;
}
```
beforeEach 默认路由：`mockFetch({ "/api/pi-matrix-bridge/config": { ok: true, homeserverUrl: "", accessToken: "", autoConnect: true, encryption: true, session: { workspace: "" }, auth: { trustedUsers: [] } }, "/api/pi-matrix-bridge/status": { ok: true, state: "stopped", pid: null, logs: [] } });`

用例改造：
```tsx
  it("adds a valid trusted user via POST /config (not plugin_config_write)", async () => {
    render(<Settings pluginContext={undefined} />);
    fireEvent.change(screen.getByTestId("trusted-user-input"), { target: { value: "@alice:example.org" } });
    fireEvent.click(screen.getByTestId("add-user"));
    const post = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "POST",
    );
    expect(post).toBeDefined();
    const body = JSON.parse((post![1] as RequestInit).body as string) as { trustedUsers: string[] };
    expect(body.trustedUsers).toContain("@alice:example.org");
    expect(contextMock.send).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pair-error")).not.toBeInTheDocument();
  });

  it("seeds connection + pairing from GET /config", async () => {
    mockFetch({
      "/api/pi-matrix-bridge/config": {
        ok: true, homeserverUrl: "https://file.example.org", accessToken: "syt_file_token",
        autoConnect: true, encryption: true, session: { workspace: "/tmp/ws" }, auth: { trustedUsers: ["@alice:example.org"] },
      },
      "/api/pi-matrix-bridge/status": { ok: true, state: "stopped", pid: null, logs: [] },
    });
    render(<Settings pluginContext={undefined} />);
    expect(await screen.findByDisplayValue("https://file.example.org")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("syt_file_token")).toBeInTheDocument();
    expect(await screen.findByText("@alice:example.org")).toBeInTheDocument();
  });

  it("rejects an invalid user id with an error and does not POST", () => {
    render(<Settings pluginContext={undefined} />);
    fireEvent.change(screen.getByTestId("trusted-user-input"), { target: { value: "not-a-user" } });
    fireEvent.click(screen.getByTestId("add-user"));
    expect(screen.getByTestId("pair-error")).toBeInTheDocument();
    const posts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => (c[1] as RequestInit)?.method === "POST");
    expect(posts).toHaveLength(0);
  });
```
  会话状态用例不变；「persists via plugin_config_write」用例删除（被第一用例取代）。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/pi-matrix-bridge-plugin && npx vitest run test/unit/client.test.tsx`
Expected: FAIL（配对仍走 `plugin_config_write`；无 `conn` 状态）。

- [ ] **Step 3: 实现 client.tsx + configSchema.json**

`client.tsx` 连接/配对绑定：
- 状态：`const [conn, setConn] = useState({ homeserverUrl: "", accessToken: "", trustedUsers: [] as string[] });`、`const [connError, setConnError] = useState<string | null>(null);`
- 挂载 effect（`getStatus` 既有 effect 旁）：
```tsx
  useEffect(() => {
    let alive = true;
    fetch(`${API}/config`)
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as Partial<MatrixBridgeConfig>;
        if (!alive) return;
        setConn({
          homeserverUrl: data.homeserverUrl ?? "",
          accessToken: data.accessToken ?? "",
          trustedUsers: data.auth?.trustedUsers ?? [],
        });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
```
- 水合 effect 的 `hasData` 改为会话侧（删连接字段判定），`setHomeserverUrl/setAccessToken` 两行删除（连接来自文件）。
- `persistSession` + `writeConn` + `saveConnection`：
```tsx
  const persistSession = () =>
    void send({
      type: "plugin_config_write",
      id: "pi-matrix-bridge",
      config: { ...config, autoConnect, encryption, session: { workspace } },
    });

  const writeConn = (next: { homeserverUrl: string; accessToken: string; trustedUsers: string[] }) => {
    void fetch(`${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    })
      .then(async (res) => {
        const data = (await res.json()) as { ok?: boolean; error?: string } & Partial<MatrixBridgeConfig>;
        if (!data.ok) {
          setConnError(data.error ?? `config ${res.status}`);
          return;
        }
        setConnError(null);
        setConn({
          homeserverUrl: data.homeserverUrl ?? next.homeserverUrl,
          accessToken: data.accessToken ?? next.accessToken,
          trustedUsers: data.auth?.trustedUsers ?? next.trustedUsers,
        });
      })
      .catch((e) => setConnError(e instanceof Error ? e.message : String(e)));
  };

  const saveConnection = () => {
    persistSession();
    writeConn(conn);
  };
```
- 表单 homeserver/accessToken 输入改绑 `conn`：`value={conn.homeserverUrl}` + `onChange={(e) => setConn({ ...conn, homeserverUrl: e.target.value })}`（accessToken 同理）。
- 配对：`const trustedUsers = conn.trustedUsers;`（删 `config.auth?.trustedUsers` memo）；`addUser`/`removeUser` 改调 `writeConn({ ...conn, trustedUsers: users })`，删 `persist({ auth: ... })`；`newUser` 输入保留。
- `connError` 在保存按钮旁渲染：`{connError && <div data-testid="conn-error" className={ERR_CLS}>{connError}</div>}`。
- 面板 A 注释更新（配置来自 `~/.pi/matrix-bridge.json`）。

`configSchema.json` 全文：
```json
{
  "$id": "@blackbelt-technology/pi-matrix-bridge-plugin/configSchema",
  "description": "Session-side plugin config (workspace/autoConnect/encryption). Connection and pairing config lives in the native bridge file ~/.pi/matrix-bridge.json and is never persisted here.",
  "type": "object",
  "properties": {
    "autoConnect": { "type": "boolean" },
    "encryption": { "type": "boolean" },
    "session": {
      "type": "object",
      "properties": { "workspace": { "type": "string" } }
    }
  },
  "required": ["autoConnect", "encryption", "session"],
  "additionalProperties": false
}
```
  （`$id` 与既有文件首行一致，按需微调以匹配原文件格式。）

- [ ] **Step 4: 构建 + 单测通过**

Run: `cd packages/pi-matrix-bridge-plugin && npx tsc --noEmit && npx vitest run test/unit/client.test.tsx`
Expected: 无类型错误 + PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/pi-matrix-bridge-plugin/src/client.tsx packages/pi-matrix-bridge-plugin/configSchema.json packages/pi-matrix-bridge-plugin/test/unit/client.test.tsx
git commit -m "feat(pi-matrix-bridge): settings page reads/writes native bridge file; store holds session-side only"
```

---

### Task 5: 全量回归 + 文档同步

**Files:**
- Run: 包全量测试 + `openspec validate --changes`
- Modify: `openspec/changes/matrix-bridge-config-import-mirror-fix/design.md`（若实现出现偏离：更新 D 决策描述；否则仅核对）
- Modify: `packages/pi-matrix-bridge-plugin/AGENTS.md`（Task 1 已改行；补 client 行如有变化）
- Modify: `packages/pi-matrix-bridge-plugin/README.md`（如含 mirror 描述，更新为 native-file config 语义 —— 可选项，仅改不实之处）

- [ ] **Step 1: 全量回归**

Run: `cd packages/pi-matrix-bridge-plugin && npx vitest run`
Expected: 全绿（bridge-file/server/client/session/types/index）。然后根目录 `npm test`（不要求全仓绿，仅确认本包相关无回归）。

- [ ] **Step 2: openspec 校验**

Run: `cd <repo-root> && openspec validate --changes`
Expected: `✓ change/matrix-bridge-config-import-mirror-fix`（1 passed）。

- [ ] **Step 3: 文档核对**

`design.md`/`superpower-design.md` 与落地代码如有出入（如 `writeBridgeConfig` 返回值用法、`fileValues` 刷新方式），就地修正为实况。

- [ ] **Step 4: Commit**

```bash
git add openspec/changes/matrix-bridge-config-import-mirror-fix/design.md packages/pi-matrix-bridge-plugin/AGENTS.md
git commit -m "docs(pi-matrix-bridge): sync design with native-file implementation"
```

---

## Self-Review（写作时已执行）

- **Spec 覆盖**：spec delta 场景 ↔ 任务：设置页显示文件配置 ↔ T3/T4；保存配置写入文件（嵌套/前缀/channels/600）↔ T1/T3；写入失败提示 ↔ T3（400/500 + 客户端 conn-error）；注册期快照 + 自动启动 ↔ T2；文件缺失静默降级 ↔ T1/T2；保存后快照刷新 ↔ T3。
- **占位符**：无 TBD/TODO；新代码全部内联。
- **类型一致性**：`effective()`/`flattenBridgeFile`/`writeBridgeConfig`/`BridgeConfigError`/`BridgeFileJson`/`stripMatrixPrefix` 跨任务一致；`conn` 三字段（homeserverUrl/accessToken/trustedUsers）客户端/端点/适配器一致；`ServerBridgeOptions.filePath` 全仓统一。
- **测试要点**：`makeCtx` 增 fastify 覆写参后既有用例不受影响；`git mv` 保留历史；E10 防误建空文件有专门用例。