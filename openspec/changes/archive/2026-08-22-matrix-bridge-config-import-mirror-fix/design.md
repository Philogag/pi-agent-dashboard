# Design: matrix-bridge-config-import-mirror-fix

## Context

现状（参见 proposal.md - Why）：WebUI 配置来源只有 dashboard 插件存储（`plugins.pi-matrix-bridge.*` in `~/.pi/dashboard/config.json`，当前仅 `{enabled:true}`），存量配置在 `~/.pi/matrix-bridge.json`（上游扩展原生 schema：顶层 `matrix.{homeserverUrl,accessToken}` + `auth.trustedUsers`/`auth.channels`；权限 600）。代码事实：

- `packages/pi-matrix-bridge-plugin/src/server/index.ts` — `readConfig()` 仅 `ctx.getPluginConfig<Partial<MatrixBridgeConfig>>()` 叠加默认值；自动启动判定 `autoConnect && homeserverUrl && accessToken`（输入=存储）；`runMirror()` 每次生命周期动作把存储配置镜像到文件。
- `packages/pi-matrix-bridge-plugin/src/server/mirror.ts` — `bridgeFilePath()` = `~/.pi/matrix-bridge.json`；`toBridgeFile()` 输出**扁平**结构（与扩展读取端不兼容）；`writeBridgeFile()` 0600 + mkdir。无读回路径。
- `packages/pi-matrix-bridge-plugin/src/server/session.ts` — `BackgroundSession` 构造接收**同步** `() => MatrixBridgeConfig` 读取器（`startImpl` 内调用），env 注入 `PI_MATRIX_BRIDGE_HOMESERVER/ACCESS_TOKEN/AUTO_CONNECT`。
- 上游 `pi-matrix-bridge` 扩展读取端只认 `config.matrix?.homeserverUrl`（`dist/index.js:175`）；子进程 `pi print` 由扩展自身读 `~/.pi/matrix-bridge.json`，env 覆盖之。
- 客户端表单数据源 = `usePluginConfig` ← `GET /api/config` ← 插件存储原始值；`persist()` 走 `plugin_config_write`；配对列表取 `config.auth?.trustedUsers`。
- 既有测试：`test/unit/mirror.test.ts` 断言扁平 schema；`test/unit/client.test.tsx` 断言配对经 `plugin_config_write`；`test/unit/server.test.ts` 断言注册期镜像写出。

## Goals / Non-Goals

**Goals:**

- `~/.pi/matrix-bridge.json` 成为连接/配对配置的**单一事实源**；设置页直接读写它（`GET`/`POST /api/pi-matrix-bridge/config`）。
- 删除镜像机制（`mirror.ts` → `bridge-file.ts` 适配器），插件存储瘦身为会话侧字段（`workspace`/`autoConnect`/`encryption` + `enabled`），`configSchema.json` 收窄。
- 后台会话自动启动判定沿用既有逻辑（存储 `autoConnect` && 连接可用），连接输入换为文件快照。
- 全过程先红后绿（TDD）+ 端点真实 fastify 单测。

**Non-Goals:**

- **不持久化导入**（用户决策）：文件快照只进内存，绝不写插件存储、无 `plugin_config_write` 连接字段。
- 不实现文件监视（watch）或「从文件导入」按钮 —— 文件本就是唯一源，无「导入」概念。
- 不搬运/迁移 `matrix-bridge-store.json`、`matrix-bridge-crypto/`（matrix-bot-sdk 运行时存储，非配置）。
- 不处理上游扩展的环境变量覆盖（`PI_MATRIX_BRIDGE_*` 仅对其自身进程可见；本插件 spawn 注入 env 的行为保持不变）。
- 自动启动行为本身不在本变更中改动；「文件配置就绪后自动启动命中」不列为验证项（用户决策：只验证设置页加载与文件 schema，会话自动启动后续再验）。
- 运行中会话不因文件改动热重启（env 在 spawn 时固化；保存后需手动 `/restart`，文档化）。

## Decisions

**D1 — 单一事实源：原生文件（用户决策）。**
删除镜像：`writeBridgeFile` / `toBridgeFile` / `redact` / `runMirror` / `MIRROR_ERROR_TYPE` 全部移除；`mirror.ts` 改名 `bridge-file.ts`，成为原生文件适配器。连接+配对只存在于 `~/.pi/matrix-bridge.json`；插件存储不再存连接字段。

**D2 — 注册期快照 + 同步 `effective()` getter（session.ts 零改动）。**
`registerPlugin()` 内 `await readBridgeFile(opts.filePath ?? bridgeFilePath())` 读一次 → `let fileValues`（快照）。定义同步 getter：
`effective() = { homeserverUrl/accessToken ← fileValues（缺失→""）, autoConnect/encryption/workspace ← readConfig()（存储） }`。
`BackgroundSession(effective, ...)` —— spawn 用合并视图；`session.ts` 不动。快照变量用 `let`，供 POST 保存后刷新（D5）。

**D3 — 设置页读写走 REST（客户端不再为连接字段发 `plugin_config_write`）。**
- `GET /api/pi-matrix-bridge/config` → `{ ok, homeserverUrl, accessToken, autoConnect, encryption, session:{workspace}, auth:{trustedUsers} }`：连接+配对来自快照（`matrix.*` 展平、`trustedUsers` 剥 `matrix:` 前缀），会话侧来自存储。accessToken 明文回显（本地 0600 文件；表单 `type=password`）。
- `POST /api/pi-matrix-bridge/config` body `{ homeserverUrl, accessToken, trustedUsers }`（无 `autoConnect/workspace/encryption` —— 那些仍走 `plugin_config_write`）→ `writeBridgeConfig()`：嵌套 `matrix.*` 写出、`trustedUsers` 加 `matrix:` 前缀、读-改-写合并 `auth.channels`、0600 → 成功刷新 `fileValues` 并返回更新视图 `{ ok, ...view }`；失败返回 `{ ok:false, error }`（500）。无文件且连接字段全空 → 400（防误建空文件）。
- 客户端 `client.tsx`：挂载时 `GET /config` 种入连接/配对 state；保存连接/增删用户 → `POST /config`；`persist()`（`plugin_config_write`）只发会话侧字段。
备选（否决）：服务端 `/api/config` 注入默认视图（跨插件改造 runtime，重）；维持 `usePluginConfig` 为连接数据源（设置页永远看不到文件值，目标落空）。

**D4 — 插件存储瘦身 + schema 收窄。**
`configSchema.json` 只保留 `{ autoConnect: boolean, encryption: boolean, session: { workspace: string } }`（required 保持该三键，`additionalProperties: false`）；连接/配对键删除。`persist()` 的 `{...config, ...next}` 语义不变，但调用点只传会话侧字段。

**D5 — 自动启动与快照刷新。**
注册期：`const initial = effective(); if (initial.autoConnect && initial.homeserverUrl && initial.accessToken) bridge.start()`（判定与输入替换均按 spec）。POST `/config` 成功 → `fileValues = 新快照` → 再次 `effective()` 即时反映；运行中会话需 `/restart` 才换 env（文档化）。

**D6 — 删除行为与兼容。**
- `ServerBridgeOptions.mirrorTarget` → `filePath?: string`（测试注入文件路径；生产缺省 `bridgeFilePath()`）。
- 转发门（配对 gate）改用 `effective().auth.trustedUsers`（快照含文件配对用户）。
- 设置页新增 `source`/导入提示不再需要（文件即源，恒显示文件值）；删除计划中的来源提示。

**D7 — 测试先红后绿。**
- `test/unit/mirror.test.ts` → 更名 `bridge-file.test.ts`：`readBridgeFile`（读取/缺失/损坏/无效→null）、`stripMatrixPrefix`、`flattenBridgeFile`（展平+剥前缀）、`writeBridgeConfig`（嵌套、前缀、channels 合并、0600、mkdir、连接全空且无文件→抛错）。
- `test/unit/server.test.ts`：删镜像断言 → 「注册期快照 + 空存储 + 有效文件 → 自动启动（spawn env）」；「无文件 → 不启动」；`GET`/`POST /config` 真实 fastify 用例（POST 后 GET 一致、channels 保留、错误路径）。
- `test/unit/client.test.tsx`：配对经 `POST /config`（fetch），不再断言 `plugin_config_write`；挂载种入来自 `GET /config`；保存连接双路径（POST + 会话侧写存储）。

## Risks / Trade-offs

- **并发双写**（本插件 `POST /config` 与扩展 `configure matrix`/DM 命令）→ 单写入方原则：写入端读-改-写合并 `auth.channels`；不监视文件；两写入方 schema 一致（同一嵌套格式）。
- **运行中会话不感知文件改动** → env 固化于 spawn；保存后手动 `/restart`；文档化提示。
- **accessToken 明文入口面** → 文件权限 600 + 与扩展自身行为一致；不落插件存储、不落日志。
- **旧存储残留连接字段**（若有）→ schema 收窄后下次 `plugin_config_write` 重写整个对象即清除；当前存储只有 `enabled`，无迁移负担。
- **内存快照与文件不同步的窗口**（外部改文件后、下次 boot 前）→ 接受：快照仅注册期与保存后两处刷新；扩展改文件后需重启 dashboard 或经 WebUI 保存一次。
- **复活边界的消失**：存储不再存连接字段 → 原「清空后文件值复活」风险整体消失（简化）。

## Migration Plan

1. D2 快照 + D7 `bridge-file.test.ts`（先红后绿）→ 跑 `npm test`（`packages/pi-matrix-bridge-plugin`）。
2. D1 删除镜像 + D3/D5 `/config` 端点 + real-fastify 单测（红→绿）。
3. D4 schema 收窄 + 客户端改造 + `client.test.tsx` 更新（红→绿）。
4. dashboard 重启（`curl -X POST http://localhost:8000/api/restart`）→ 本机验证（用户决策的验证项）：设置页显示 `https://matrix.philogag.com` + token 回显 + 配对去前缀展示；点「保存连接配置」→ 文件保持嵌套、`auth.channels` 不变、权限 600；存储不新增连接字段。
5. 回滚：插件运行时加载，还原改动重启即可；无存储改写残留（快照纯内存）。