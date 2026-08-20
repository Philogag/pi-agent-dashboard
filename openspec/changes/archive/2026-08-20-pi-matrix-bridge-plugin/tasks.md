## 1. 配置类型与 schema

- [x] 1.1 在 `packages/pi-matrix-bridge-plugin/src/` 定义 `MatrixBridgeConfig` 类型（字段：`homeserverUrl`、`accessToken`、`encryption`、`autoConnect`、`session.workspace`、`auth.trustedUsers: string[]`），并在 `src/server/index.ts` 与 `src/client.tsx` 共享使用（参照 design D1/D4）
- [x] 1.2 填充 `configSchema.json`（JSON Schema 7）：声明上述字段、类型与必需项，`trustedUsers` 为 `@user:server` 字符串数组（校验见任务 5.1）

## 2. 配置持久化与镜像

- [x] 2.1 `src/client.tsx` 实现 Matrix 连接配置表单（homeserver URL、access token 密码态输入、E2EE 开关、自动连接开关、workspace 输入），保存经 `usePluginSend({type:"plugin_config_write"})` 持久化；无配置时不报错、显示缺省
- [x] 2.2 `src/server/mirror.ts` 实现镜像写入 `~/.pi/matrix-bridge.json`（权限 600；`trustedUsers` 加 `matrix:` 前缀映射，access token 落盘 0600 且 `redact()` 日志脱敏）；镜像失败记日志并广播 `pi-matrix-bridge_mirror_error`，但不阻断插件配置持久化（spec R2 场景）

## 3. 后台 pi 会话生命周期（server）

- [x] 3.1 实现状态机与 spawn/stop/restart：server 持有单一子进程句柄 + `state`（`stopped → running → stopping`、`running → exited`），以 `child_process.spawn("pi", print 模式, {cwd})` 拉起并注入 Matrix 配置环境变量（design D0/D2）
- [x] 3.2 自动启动：`registerPlugin(ctx)` 时若 `autoConnect && 配置完整` 则 spawn（design D3）
- [x] 3.3 工作目录校验：workspace 不存在/不可读时拒绝启动并在状态中报告原因；无配置时不创建任何进程（spec R4 场景）
- [x] 3.4 进程清理与意外退出：server 关停钩子 kill 子进程（SIGTERM→超时 SIGKILL）；子进程意外退出时更新状态为「已退出」并记录原因（spec R3 场景）

## 4. 生命周期 REST API 与 WS 可见性

- [x] 4.1 以 `ctx.fastify.register(routes, {prefix:"/api/pi-matrix-bridge"})` 暴露 `GET /status`、`POST /start|/stop|/restart`，与设置页交互一致（spec R6）
- [x] 4.2 状态与实时日志行经 `ctx.broadcastToSubscribers` / WS 推送设置页；初始连接回放最近状态与日志（spec R5 场景）

## 5. 可信用户配对面板（client）

- [x] 5.1 配对面板：可信用户列表增删 UI + 格式校验（`/^@[^:]+:.+$/`，非法输入拒绝并提示），持久化为 `auth.trustedUsers`（spec R4、design D4）
- [x] 5.2 状态展示：设置页绑定 4.1/4.2，显示运行中/已停止/已退出 + PID + 实时日志区

## 6. 主动推送预留通道（server）

- [x] 6.1 预留主动推送途经：`ctx.onEvent((sessionId, event) => …)`，`sessionId` 取自传输层（会话 socket 键、忽略事件体自报来源、不可伪造），仅当 `trustedUsers` 非空时转发为 `pi-matrix-bridge_forward` 广播（spec R7、design D5；运行时的 `registerPiHandler` 为单参，故改走 `onEvent` 取传输层 sessionId）
- [x] 6.2 转发决策骨架：是否把主动消息转发至后台会话/桥接需受 `auth.trustedUsers` 约束；本期可仅落地接收与来源记录，转发留扩展点

## 7. 测试、文档与收尾

- [x] 7.1 `test/` 补 server 侧单元测试：状态机迁移、镜像写入（含 `matrix:` 前缀与 0600 权限）、无效 workspace 拒绝启动（TDD，先写测试）
- [x] 7.2 补 client 侧测试：配置表单保存、配对面板增删与非法 ID 校验
- [x] 7.3 更新 `packages/pi-matrix-bridge-plugin/README.md`：前置依赖（本机需 `pi` 命令与 `npm:pi-matrix-bridge` 扩展）、环境变量（`PI_MATRIX_BRIDGE_HOMESERVER/_ACCESS_TOKEN`）覆盖文件配置的说明、首次启用步骤
- [x] 7.4 按 Documentation Update Protocol 更新 `packages/pi-matrix-bridge-plugin/AGENTS.md` 相应文件行（configSchema.json、src/server/index.ts、src/client.tsx、test/*）
- [x] 7.5 终验：`npm test --workspace @blackbelt-technology/pi-matrix-bridge-plugin` 全绿；`openspec validate pi-matrix-bridge-plugin` 通过
