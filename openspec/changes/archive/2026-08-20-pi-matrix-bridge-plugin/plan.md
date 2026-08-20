# Pi Matrix Bridge Plugin Implementation Plan

> **给 agentic worker 使用：** 用 superpowers:subagent-driven-development 逐任务实现本计划。

---
change: pi-matrix-bridge-plugin
design-doc: openspec/changes/pi-matrix-bridge-plugin/design.md
base-ref: d136daded5f1522fcec2b419ff4ffd6e1199d006
---

**Goal:** 为 `rolznz/pi-matrix-bridge` 提供 pi-dashboard 兼容层：设置页配置 Matrix 连接与可信用户配对，并在 dashboard 进程内托管一个带 Matrix 连接、workspace 可配置的后台 pi 会话。

**Architecture:** server 入口 `registerPlugin(ctx)` 直接 `child_process.spawn("pi", print 模式, {cwd})` 托管单一后台子进程（决策 D0/D2），`matrix:` 前缀镜像到 `~/.pi/matrix-bridge.json`（0600，D1）；生命周期经 `GET/POST /api/pi-matrix-bridge/{status,start,stop,restart}` 驱动，状态与日志经 `ctx.broadcastToSubscribers` 推送设置页；UI 仅声明 `settings-section`（配置面板 + 配对面板）。

**Tech Stack:** TypeScript / ESM；`@blackbelt-technology/dashboard-plugin-runtime`(ServerPluginContext, usePluginConfig/usePluginSend) + `pi-dashboard-shared`(SlotProps)；`child_process.spawn`(Node)；vitest + @testing-library/react(jsdom)。本机需 `pi` 命令与 `npm:pi-matrix-bridge` 扩展（spawn 前置，设计中列为依赖）。

> 运行/校验命令：`npm test --workspace @blackbelt-technology/pi-matrix-bridge-plugin`（vitest run）、`openspec validate pi-matrix-bridge-plugin`。

---

## 文件结构

- 新建 `src/types.ts` — 共享 `MatrixBridgeConfig` 类型、`EMPTY_CONFIG`、`isUserMatrixId()`、`matrixUserId()`、`BridgeState`。
- 新建 `src/server/session.ts` — `BackgroundSession` 类：spawn/stop/restart + 状态机 + cwd 校验 + 日志缓冲 + 清理；`spawnImpl` 可注入以便测试。
- 新建 `src/server/mirror.ts` — `writeBridgeFile(config, targetPath)`：写 `~/.pi/matrix-bridge.json`(0600)，`trustedUsers` 加 `matrix:` 前缀。
- 修改 `src/server/index.ts` — `registerPlugin(ctx)`：接线 session + mirror、注册 REST 路由、WS 推送与回放、自动启动、关停清理、`plugin_pi_message` 预留处理器。
- 修改 `src/client.tsx` — `Settings`：Matrix 配置表单 + 配对面板 + 状态/日志展示。
- 修改 `configSchema.json` — 填充 properties。
- 测试：`test/unit/types.test.ts`、`test/unit/mirror.test.ts`、`test/unit/session.test.ts`、`test/unit/client.test.tsx`（`test/index.test.ts` manifest 冒烟保留）。

## Task 1: 共享配置类型与 schema

- [ ] **Step 1 (TDD):** 新建 `test/unit/types.test.ts`，写失败测试：`isUserMatrixId("@alice:example.org")===true`、`isUserMatrixId("not-a-user")===false`、`matrixUserId("@alice:example.org")==="matrix:@alice:example.org"`、`EMPTY_CONFIG` 含预期缺省。
- [ ] **Step 2:** 运行 `npm test --workspace @blackbelt-technology/pi-matrix-bridge-plugin`，确认失败（types 未定义）。
- [ ] **Step 3 (实现):** 新建 `src/types.ts`：
  ```ts
  export interface MatrixBridgeConfig {
    homeserverUrl: string;
    accessToken: string;
    encryption: boolean;
    autoConnect: boolean;
    session: { workspace: string };
    auth: { trustedUsers: string[] }; // 存 @user:server（无 matrix: 前缀），镜像时加前缀
  }
  export type BridgeState = "stopped" | "running" | "stopping" | "exited";
  export const EMPTY_CONFIG: MatrixBridgeConfig = { homeserverUrl:"", accessToken:"", encryption:true, autoConnect:true, session:{workspace:""}, auth:{trustedUsers:[]} };
  export const isUserMatrixId = (s: string) => /^@[^:]+:.+$/.test(s);
  export const matrixUserId = (s: string) => `matrix:${s}`;
  ```
- [ ] **Step 4:** 运行测试，通过。
- [ ] **Step 5:** 填充 `configSchema.json` properties：`homeserverUrl{type:string}`,`accessToken{type:string}`,`encryption{type:boolean,default:true}`,`autoConnect{type:boolean,default:true}`,`session{type:object,properties:{workspace{type:string}},required:[workspace]}`,`auth{type:object,properties:{trustedUsers{type:array,items{type:string}}},required:[trustedUsers]}`；`required:[homeserverUrl,accessToken,encryption,autoConnect,session,auth]`；`additionalProperties:false`。
- [ ] **Step 6:** `openspec validate pi-matrix-bridge-plugin` 通过；提交 `feat: add shared config types + configSchema`.

## Task 2: 镜像写入 `~/.pi/matrix-bridge.json`

- [ ] **Step 1 (TDD):** 新建 `test/unit/mirror.test.ts`：给一个 tmp 目标路径，写失败测试——调用 `writeBridgeFile(cfg, tmpPath)` 后文件存在、`JSON.parse` 的 `auth.trustedUsers[0]==="matrix:@alice:example.org"`、文件 mode 为 `0o600`、accessToken 落盘但 `buildRedactedConfig()` 输出不含明文 token。
- [ ] **Step 2:** 运行测试确认失败。
- [ ] **Step 3 (实现):** 新建 `src/server/mirror.ts`：
  ```ts
  import { mkdir, writeFile, chmod } from "node:fs/promises";
  import { homedir } from "node:os";
  import { join } from "node:path";
  import type { MatrixBridgeConfig } from "../types.js";
  import { matrixUserId } from "../types.js";
  // 桥接文件键名需对照 pi-matrix-bridge README 校准（design Open Question）
  export const bridgeFilePath = () => join(homedir(), ".pi", "matrix-bridge.json");
  export function toBridgeFile(cfg: MatrixBridgeConfig) {
    return { homeserverUrl: cfg.homeserverUrl, accessToken: cfg.accessToken,
      auth: { trustedUsers: cfg.auth.trustedUsers.map(matrixUserId) } };
  }
  export function redact(cfg: MatrixBridgeConfig): string | null { ... 返回脱敏 JSON（token→"***"）或 null }
  export async function writeBridgeFile(cfg: MatrixBridgeConfig, target = bridgeFilePath()): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(toBridgeFile(cfg), null, 2));
    await chmod(target, 0o600);
  }
  ```
- [ ] **Step 4:** 测试通过。
- [ ] **Step 5:** 提交 `feat: mirror config to ~/.pi/matrix-bridge.json (0600)`.

## Task 3: 后台会话生命周期（BackgroundSession）

- [ ] **Step 1 (TDD):** 新建 `test/unit/session.test.ts`，`spawnImpl` 注入假实现，写失败测试：
  - `start()` 以 `cwd` 调用 spawn、状态转 `running`、暴露 `pid`；
  - workspace 不存在时返回 `{ok:false, reason}` 且不 spawn；
  - `stop()` 发 `SIGTERM`（假 child 记录），状态 `stopping`→`stopped`；
  - 子进程 `exit` 事件把状态置 `exited` 并缓冲原因；
  - `restart()` = stop 后按最新配置再 start。
- [ ] **Step 2:** 运行确认失败。
- [ ] **Step 3 (实现):** 新建 `src/server/session.ts`：
  ```ts
  import { spawn, type ChildProcess } from "node:child_process";
  import { existsSync } from "node:fs";
  import type { MatrixBridgeConfig, BridgeState } from "../types.js";
  export interface SessionInfo { state: BridgeState; pid: number | null; exitReason?: string; }
  export interface SpawnEnv { [k: string]: string | undefined }
  export class BackgroundSession {
    child: ChildProcess | null = null;
    state: BridgeState = "stopped";
    exitReason?: string;
    logs: string[] = []; // 环形缓冲（最近 ~200 行）
    constructor(private cfg: () => MatrixBridgeConfig, private spawnImpl = spawn, private onState: (s: SessionInfo)=>void = ()=>{}) {}
    async start(): Promise<{ok:boolean; reason?:string}> {
      const { session:{workspace}, homeserverUrl, accessToken, autoConnect } = this.cfg();
      if (!homeserverUrl || !accessToken) return { ok:false, reason:"matrix config incomplete" };
      if (workspace && !existsSync(workspace)) return { ok:false, reason:`workspace not found: ${workspace}` };
      const env: SpawnEnv = { ...process.env, PI_MATRIX_BRIDGE_HOMESERVER: homeserverUrl,
        PI_MATRIX_BRIDGE_ACCESS_TOKEN: accessToken, PI_MATRIX_BRIDGE_AUTO_CONNECT: autoConnect ? "1" : "0" };
      this.state = "stopping"; // 防并发 start
      this.child = this.spawnImpl("pi", ["print"], { cwd: workspace || homedir(), env });
      this.state = "running"; this.exitReason = undefined;
      this.child.stdout?.on("data", d => this.push(d.toString()));
      this.child.stderr?.on("data", d => this.push(d.toString()));
      this.child.on("exit", (code, sig) => { this.state = "exited"; this.exitReason = `exit ${code}${sig?` ${sig}`:""}`; this.emit(); });
      this.emit(); return { ok:true };
    }
    // stop(): child ? (this.state="stopping"; child.kill("SIGTERM"); 超时 5s→SIGKILL) : (state="stopped")
    // restart(): await stop(); return start();
    // detach(): 释放引用并 kill（SIGTERM→超时 SIGKILL），供 server 关停
  }
  ```
  > **校准点**（design Open Question）：`PI_MATRIX_BRIDGE_*` 环境变量名、`print` 参数、桥接是否改读文件——实现时对照 `pi-matrix-bridge` README 复核，非关键字段可后续微调。
- [ ] **Step 4:** 测试通过。
- [ ] **Step 5:** 提交 `feat: BackgroundSession state machine + spawn/stop/restart`.

## Task 4: server 接线（registerPlugin）

- [ ] **Step 1 (TDD):** 为 `test/unit/server.test.ts` 造最小 `ctx` stub（`fastify.get/post` 捕获注册的 handlers、`broadcastToSubscribers`、`registerBrowserHandler`、`registerPiHandler`、`logger`、`pluginConfig`、`getPluginConfig`、`updatePluginConfig`），写失败测试：调用 `registerPlugin(ctx)` 后 `registerPiHandler` 被调用一次（预留通道）、autoConnect 且配置完整时 `BackgroundSession.start` 被触发、`fastify` 注册了 `/start|/stop|/restart|/status`。
- [ ] **Step 2:** 运行确认失败。
- [ ] **Step 3 (实现):** 重写 `src/server/index.ts`：
  - 定义并导出 `PiMatrixBridgeConfig`（re-export from `../types.js`）。
  - `const bridge = new BackgroundSession(() => cfg, undefined, info => broadcast({type:"pi-matrix-bridge_status", info}))`。
  - `autoConnect && cfgIsComplete(cfg)` → `await bridge.start()`（design D3）。
  - `ctx.fastify.register(async r => { r.get("/status", ...); r.post("/start", ...); r.post("/stop", ...); r.post("/restart", ...); }, { prefix: "/api/pi-matrix-bridge" })`——每个 handler 调 `bridge.start()/stop()/restart()` 并把返回值作为状态返回（spec R6）。
  - `ctx.registerBrowserHandler("pi-matrix-bridge_status_replay" as never, async (_m, send) => send({type:"pi-matrix-bridge_status", info: bridge.info(), logs: bridge.logs.slice()}))`——设置页打开时回放（spec R5）。
  - 配置写入钩子：`updatePluginConfig` 时若配置已持久化 → 调 `writeBridgeFile` 镜像；失败 `ctx.logger.warn` + 广播 `pi-matrix-bridge_mirror_error`（spec R2，不阻断持久化）。
  - 关停清理：`process.on("SIGTERM"/"SIGINT")` 或 server 提供的退出钩子 → `bridge.detach()`（design Risks 孤儿进程）。
- [ ] **Step 4:** 测试通过。
- [ ] **Step 5:** 提交 `feat: wire BackgroundSession + REST routes + WS replay + auto-start + cleanup`.

## Task 5: 主动推送预留通道

- [ ] **Step 1 (TDD):** 扩展 `test/unit/server.test.ts`：注入一条来自 sessionId `"X"` 的 `plugin_pi_message`，断言处理函数参数里的来源标识为 `"X"`（取自传输层）；构造一条消息体自报 `sessionId:"ff"` 的，断言仍用传输层 `"X"`（不可伪造，spec R7）。
- [ ] **Step 2:** 运行确认失败。
- [ ] **Step 3 (实现):** 在 `registerPlugin` 中 `ctx.registerPiHandler("<约定消息类型>" as never, async (msg, sessionId) => { /* 记录来源 sessionId；转发后台会话受 trustedUsers 约束——本期仅接收+记录，转发留扩展点（design D5/6.2） */ })`。
- [ ] **Step 4:** 测试通过。
- [ ] **Step 5:** 提交 `feat: reserved plugin_pi_message pathway with unspoofable sessionId`.

## Task 6: 设置页客户端（配置表单 + 配对 + 状态）

- [ ] **Step 1 (deps):** 加入 `@testing-library/react`、`@testing-library/jest-dom`、`jsdom` 到该包 devDependencies；`vitest.config.ts` 加 `environment:"jsdom"`（仅对本测试文件，可 `// @vitest-environment jsdom` 文件级声明）。
- [ ] **Step 2 (TDD):** 新建 `test/unit/client.test.tsx`，mock `@blackbelt-technology/dashboard-plugin-runtime/context`（`usePluginConfig` 返回受控 config、`usePluginSend` 捕获发送），写失败测试：渲染 `Settings`，输入 `@alice:example.org` 后点「添加」→ 配对列表含该用户且 `plugin_config_write` 被调用、config 的 `auth.trustedUsers` 含它；输入非法串点添加 → 出格式错误提示且不写入；打开配置表单 → homeserver/token/workspace 输入框存在。
- [ ] **Step 3:** 运行确认失败。
- [ ] **Step 4 (实现):** 重写 `src/client.tsx` `Settings`：
  - Panel A「Matrix 配置」：homeserver URL、access token（`type="password"`）、E2EE 开关、自动连接开关、workspace 输入；「保存」`send({type:"plugin_config_write", id:"pi-matrix-bridge", config: { ...config, ...表单值 }})`；无配置时用 `EMPTY_CONFIG` 缺省展示、不报错（spec R1）。
  - Panel B「可信用户」：输入 + 「添加」，校验 `isUserMatrixId`；列表项带「移除」；持久化为 `auth.trustedUsers`（spec R4 / design D4）。
  - Panel C「会话状态」：`usePluginSend`/`registerBrowserHandler` 或 fetch `/api/pi-matrix-bridge/status` + 订阅 WS 状态/日志；展示 running/stopped/exited + PID + 日志区（spec R5）。
  - 配置写入侧：持久化后应触发 server 镜像（见 server 配置写入钩子），错误经 WS `pi-matrix-bridge_mirror_error` 显示。
- [ ] **Step 5:** 测试通过。
- [ ] **Step 6:** 提交 `feat: settings UI (matrix config + pairing + status)`.

## Task 7: 文档、AGENTS 行与终验

- [ ] **Step 1:** 更新 `packages/pi-matrix-bridge-plugin/README.md`：前置依赖（`pi` 命令、`npm:pi-matrix-bridge` 扩展）、env（`PI_MATRIX_BRIDGE_HOMESERVER/_ACCESS_TOKEN`）**覆盖**文件配置的说明（design 多聊天室小节点 4）、首次启用步骤（填配置→保存→自动/手动启动）。
- [ ] **Step 2:** 按 Documentation Update Protocol 更新 `packages/pi-matrix-bridge-plugin/AGENTS.md`：新增/更新 `src/types.ts`、`src/server/session.ts`、`src/server/mirror.ts` 行；更新 `src/server/index.ts`、`src/client.tsx`、`configSchema.json`、`test/*` 行。
- [ ] **Step 3:** 终验：`npm test --workspace @blackbelt-technology/pi-matrix-bridge-plugin` 全绿；`npm run typecheck --workspace ...`（若有）通过；`openspec validate pi-matrix-bridge-plugin` 通过。
- [ ] **Step 4:** 提交 `chore: docs + AGENTS rows + final verification`.
