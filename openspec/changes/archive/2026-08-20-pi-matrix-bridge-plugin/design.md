## Context

`rolznz/pi-matrix-bridge` 是一个注入 pi 进程的扩展：通过 `sendUserMessage()` 与 `turn_end` 事件把 Matrix 聊天桥接到本地 pi 智能体，让远程用户在任意 Matrix 客户端与 pi 对话。它当前完全由环境变量 / `~/.pi/matrix-bridge.json` 配置，并以「systemd 单实例 + 手工 pi 命令」方式在终端外运行——无仪表盘界面。参见 proposal.md 的 Why。

本设计服务于其配套 delta spec（`specs/matrix-bridge-plugin/spec.md`），定义 HOW，不重复需求。运行环境：`pi-dashboard-plugins` 为 npm-workspaces monorepo；插件作为独立包 `packages/pi-matrix-bridge-plugin/` 携带 `pi-dashboard-plugin` manifest，尚未 link 进 dashboard（先 monorepo + 前向兼容脚本）。dashboard server 为 `@blackbelt-technology/pi-dashboard-server`（v0.7.0，BlackBeltTechnology/pi-agent-dashboard）。

## Goals / Non-Goals

**Goals:**
- 在 dashboard 进程内拥有并管理一个「后台 pi 会话」子进程，让 Matrix 桥接随 dashboard 常驻。
- 把 Matrix 配置、workspace、可信用户配对全部纳入设置页 UI，并与桌面手动 pi 共享配置。
- 提供可观测的生命周期（status REST + WS 日志流）。

**Non-Goals:**
- 不实现任何 Matrix 协议逻辑——桥接完全由 `pi-matrix-bridge` 扩展承担（决策 D0）。
- 不引入 bridge（pi 扩展）插件入口；本插件仅做 server 侧进程管理 + 设置页 UI。
- 不做多后台会话/多租户；本版本单一后台会话。
- 不处理 Element/FluffyChat 等客户端的 UI——它们对接 Matrix 服务端，与本插件无关。

## Decisions

### D0 — 不写 bridge（pi 扩展）入口，server 直接 spawn pi
**选择**：插件「弃用 bridge 入口」，由 server 入口直接 `child_process.spawn` 一个 `pi`（print 模式）子进程，并把 Matrix 配置作为环境变量喂给它。
**理由**：`pi-matrix-bridge` 已处理实际 Matrix 连接与 E2EE；再写一层 bridge 只会重复其启动逻辑、增加维护面。保持插件精简为「配置 + 生命周期 + 状态」。（备选：写桥接入口——被否，理由如上。）
**备选**：由 dashboard 已有的 session 机制托管——dashboard 的 session 面向「一次交互式对话」；此处需要的是独立于会话的常驻子进程，故用自有 spawn 管理而非复用 session registry。

### D1 — 配置双写：dashboard 插件配置 + `~/.pi/matrix-bridge.json` 镜像
**选择**：通过 `plugin_config_write` 持久化到 dashboard 插件配置（读 `usePluginConfig<T>()` / `ctx.pluginConfig`），同时把等效配置镜像写入 `~/.pi/matrix-bridge.json`（权限 600），密钥（access token）以 0600 落盘、日志脱敏。
**理由**：满足「手动运行的桌面 pi 共享同一配置」——两种运行方式（dashboard 托管 vs 桌面手动）读同一份 Matrix 配置，避免双份凭据漂移。
**妥协**：`pi-matrix-bridge.json` 的 schema 以其扩展约定为准；本插件做一次正向映射（见 Risks）。

### D2 — 进程生命周期：single child + 简单状态机
**选择**：server 持有单一后台会话句柄（`child: ChildProcess | null` + `state`），状态机为 `stopped → running → stopping，running → exited` 等原子迁移；`GET /api/<plugin-id>/status` 返回 state + pid，`POST /start|/stop|/restart` 驱动迁移；状态与日志行经 `ctx.broadcastToSubscribers` / WS 推送设置页。
**理由**：避免多个互不知情的子进程；单例 + 显式状态满足「自动启动、手动重启、意外退出可见」的需求，且便于重启时以最新配置重建。

### D3 — 自动启动时机：插件注册且 autoConnect + 配置就绪
**选择**：注册 `registerPlugin(ctx)` 时，若 `autoConnect && config.matrix` 完整则 spawn。配置在运行中被修改时，不热重启已在跑的会话（避免中断对话）；用户可手动 restart 以应用新配置。
**理由**：随 dashboard 常驻符合「常驻后台会话」意图；已运行会话不因改配置被强行打断，避免丢连接。

### D4 — 配对 = 可信用户列表持久化
**选择**：可信用户以 `@user:server` 字符串数组存入 `auth.trustedUsers`，设置页做增删与格式校验（`/^@[^:]+:.+$/`）；该列表随环境/配置传给后台 pi 的 `pi-matrix-bridge` 扩展（由其强制只响应该列表内用户）。
**理由**：与 `pi-matrix-bridge` 的「可信用户」模型对齐；不做复杂权限模型。单实例场景用直接列表而非「配对待确认流」，满足需求且最简。

### D5 — 主动推送途径：`plugin_pi_message` + 会话标识（预留）
**选择**：预留一条「其他会话 → 本插件」的主动推送通道：调用 `registerPiHandler(<约定消息类型>, handler)`，处理程序签名 `(msg, sessionId)`。任何 dashboard 会话内运行的 pi 扩展发 `{type:"plugin_pi_message", messageType, …}`，server 即按 `messageType` 派发（`dispatchPluginPiMessage`，见 `server.ts:948`）。`sessionId` 由 gateway 的 socket 键注入、不从消息体取（`server.ts:938`）——不可被扩展伪造，是本通道来源信任的根基。本插件再决定是否转发至后台会话/桥接；转发仍受 `auth.trustedUsers` 约束。
**理由**：满足「由其他会话发起主动推送」的预留需求，且复用 dashboard 既有的事件路由，无需新增私有协议。（备选：另开 REST webhook——被否，因 `plugin_pi_message` 已提供带不可伪造来源的既有途径，且与「扩展到 pi 事件总线」的插件隔离原则一致。）
**补充**：`onEvent(sessionId, event)` 可作原始事件订阅，`sendToSession(sessionId, text)` / `emitEventToSession(sessionId, eventType, data)` 做「插件 → 目标会话」的出站注入，形成闭环。

## 多聊天会话处理（上层插件如何应对多会话）

来自 slot-taxonomy 与 server 实现的分析：

- **UI 层（client/插槽）按「全局 vs 按会话」二分**：`settings-section` 是**全局单实例**——设置页每个插件仅渲染一节，不随会话数量放大；`session-card-badge` / `session-card-action-bar` / `content-view` 等是**按会话**——每个 dashboard 会话渲染一个实例，组件经 `props.session: DashboardSession` 拿到当前会话。因此插件若要「每个会话都有个角标」就声明 per-session 插槽，要「全局配置区」就声明 settings-section。
- **server 层一律以 `sessionId` 为归属键**：`registerPiHandler` 回调 `(msg, sessionId)`、`onEvent(sessionId, event)`、`onSessionEnded(sessionId)`；`sendToSession/emitEventToSession/abortSession` 都以 `sessionId` 定向。dashboard 其余会话与本插件托管的后台会话可并存，互不串扰。
- **对本插件的落地建议**：
  1. 本插件只管**一个**后台会话（单会话 Non-Goal 不变）。
  2. UI 仅声明 `settings-section`（全局单实例）——不做 per-session 角标/卡片，避免在每会话重复渲染无关内容。
  3. server 侧把 `sessionId` 当作**归属/来源键**而非「唯一会话」来用：主动推送自其它会话进来时以其 sessionId 作来源记录；定向注入后台会话时用后台会话自己的标识。
  4. 后台会话**身份**：若走原生 `child_process.spawn`（保持 D0 的环境变量注入能力），则该后台进程不在 `sessionManager` 中、无 dashboard sessionId，定向注入只能走裸进程 stdin；若改用 `spawnSession`（`server.ts:1960`，trust 门控 `priority≤100`，本插件 priority=100 可用），可拿到真正的 sessionId 并复用 `abortSpawnedRun` 等生命周期，但 `buildSpawnEnv` **不注入任意 env**（仅加 `PI_DASHBOARD_SPAWN_TOKEN` 等）——无法直接喂 `PI_MATRIX_BRIDGE_*`。该取舍见 Open Questions。

## 多聊天室处理（rolznz/pi-matrix-bridge 的模型分析）

基于其 README 与 DeepWiki（源码 `src/index.ts`、`src/transports/matrix.ts`、`src/auth/challenge-auth.ts`）的调研：

**核心事实：桥接是「一个 bot、一条连接、一个共享 pi 对话」，不是「每房间一个会话」。**
- 单扩展入口 `src/index.ts` 仅维护**一个** `pendingRemoteChat`（当前活动远程聊天）；Matrix 消息经 `checkAuthorization(userId, chatId)` 后 `sessionManager.addEntry({role:'user', content})` 注入**同一个** pi 会话。多个房间的消息全部汇入同一段对话。
- Matrix 房间 =「通道」（channel），以 `chatId`（即 roomId）标识。管理命令 `/channels`、`/enable <chatId> <all|mentions|trusted-only>`、`/disable <chatId>` 提供**房间级**权限模式。
- **群组房间需 @提及 bot 才响应**（`wasBotMentioned`）；私聊（DM）无此要求。这是多房间共存时最重要的行为约束。
- **双维度鉴权**：`checkAuthorization(userId, chatId)` = 用户级 `trustedUsers`（如 `matrix:@alice:matrix.org`，挑战式 6 位码入门）+ 房间级 enable 模式。
- 出站按 `chatId` 定向：`sendMessage(chatId, text)` / `editMessage`，流式编辑只落在当前活动房间（`pendingRemoteChat`）。
- 单实例守护（`~/.pi/matrix-bridge.lock` + 全局旗标）防止 sub-agent 派生出重复 bot 轮询。

**对本插件的落地影响：**
1. 配对面板映射的是**用户级** `auth.trustedUsers`，且桥接要求**传输命名空间**格式 `matrix:@user:server`（配置示例 `"trustedUsers":["matrix:@alice:matrix.org"]`）——镜像时需加 `matrix:` 前缀；UI 可让用户只填 `@user:server` 再自动加前缀。
2. 房间级 enable/mention 模式由桥接的 DM 交互命令管理，**不在配置文件/本插件范围**；如需在仪表盘管理房间，未来可另立房间面板（现明确为 Non-Goal/桥接侧职责）。
3. 多个房间共享一个对话，意味着 dashboard 的「会话」概念（一个后台 pi 会话）与 Matrix 的 chatId/房间是一对多；我们的「会话归属 sessionId」指的是 pi 会话，不是房间。后台会话响应会写到哪个房间取决于桥接内部 `pendingRemoteChat`，插件不必（也不应）自己决定路由。
4. 环境变量（`PI_MATRIX_BRIDGE_HOMESERVER/_ACCESS_TOKEN`）**覆盖**文件配置——镜像 `~/.pi/matrix-bridge.json` 的桌面 pi 若在 shell 里设了 env，会以 env 为准；需在文档/Open Question 提示。

## Risks / Trade-offs

- [配置 schema 漂移] 本插件镜像 `~/.pi/matrix-bridge.json` 时若与 `pi-matrix-bridge` 期望的结构不完全一致，桌面 pi 读取可能失败 → 镜像层做正向映射 + 启动时校验关键字段，给出清晰报错。
- [E2EE 与 access token 安全] access token 明文进入 dashboard 配置与镜像文件 → 镜像文件 0600；日志不打印 token；设置页输入框用 password 态。
- [后台 pi 依赖本机安装] spawn 需要本机有 `pi` 命令与 `npm:pi-matrix-bridge` 扩展 → 启动失败时状态置「已退出」并显示原因；文档写明前置依赖。
- [子进程泄漏/孤儿进程] dashboard 退出时若不清理，后台 pi 可能残留 → server 关停钩子中 kill 子进程（SIGTERM→超时 SIGKILL）。
- [单会话限制] 不支持多后台会话 → 与需求 scope 一致，明确列为 Non-Goal。

## Migration Plan

- 新增包 `packages/pi-matrix-bridge-plugin/`，独立发布，`npm link`（或后续 node_modules 扫描）接入 BlackBeltTechnology/pi-agent-dashboard。
- 回滚：不链接该插件即可，对既有 dashboard 行为零影响（non-breaking）。
- 首次启用需用户先在设置页填写 Matrix 配置；本插件不会在无配置时创建任何后台进程。

## Open Questions

- 后台 pi 会话是否需要暴露「独立会话 ID/多会话」以对接 dashboard session 视图？（现按单会话 Non-Goal 处理，若将来需要可加。）
- `pi-matrix-bridge` 具体期望的环境变量名/配置键名（`PI_MATRIX_BRIDGE_HOMESERVER/ACCESS_TOKEN/AUTO_CONNECT` 为 proposal 假设）需在实现时对照其 README 校准。
- **后台会话的拉起方式（D0 权衡，实现期定）**：裸 `child_process.spawn` 可注入 `PI_MATRIX_BRIDGE_*` env（维持 proposal 假设），但后台进程不在 `sessionManager`、无 dashboard sessionId，定向注入仅能走 stdin；`spawnSession` 提供第一等会话身份与生命周期复用，但 `buildSpawnEnv` 不注入任意 env。可选中间态：既用 `spawnSession` 取会话身份，又以共享 `~/.pi/matrix-bridge.json`（而非 env）承载 Matrix 连接——需确认 `pi-matrix-bridge` 是否读该文件作为连接源。
