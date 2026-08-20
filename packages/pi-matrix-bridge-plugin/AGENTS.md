# DOX — packages/pi-matrix-bridge-plugin/

@blackbelt-technology/pi-matrix-bridge-plugin。仪表盘插件，为 rolznz/pi-matrix-bridge 提供兼容层：
server 入口（`registerPlugin(ctx)`）直接 `child_process.spawn` 一个后台 pi 子进程（print 模式，
经 `PI_MATRIX_BRIDGE_HOMESERVER/_ACCESS_TOKEN/_AUTO_CONNECT` env 注入 Matrix 连接；workspace 可配），
settings-section 客户端在 Settings 页配置 Matrix 连接 + trustedUsers 配对 + 会话状态/日志/启停。
配置经 `plugin_config_write` 持久化到 `~/.pi/dashboard/config.json`，并在注册与每次生命周期动作时
镜像到 `~/.pi/matrix-bridge.json`（chmod 600，`trustedUsers` 加 `matrix:` 前缀，供手动桌面 pi 共用）。
REST: GET/POST `/api/pi-matrix-bridge/{status,start,stop,restart}`；状态经
`ctx.broadcastToSubscribers({type:"pi-matrix-bridge_status",info,logs})` 推送。
Manifest id `pi-matrix-bridge`，requiredApi `^0.7.0`；bridge 入口刻意不用（server 直接 spawn pi）。
主动推送：预留 `ctx.onEvent((sessionId,event))` 观察通道（不可伪造 sessionId + trustedUsers 门控），未接转发。

| File | Purpose |
|------|---------|
| `README.md` | 使用/开发/测试说明；前置依赖（pi 命令 + npm:pi-matrix-bridge）、env 覆盖文件配置说明、首次启用步骤。 |
| `configSchema.json` | JSON Schema 7 配置 schema：properties homeserverUrl{string}/accessToken{string}/encryption{boolean,default:true}/autoConnect{boolean,default:true}/session{object,workspace{string}}/auth{object,trustedUsers{array string}}；required 全字段；additionalProperties:false。 |
| `package.json` | 插件包元数据 + 顶层 `pi-dashboard-plugin` manifest（client/client.tsx、server/server/index.ts、configSchema、claims:[settings-section→Settings]）。deps dashboard-plugin-runtime + pi-dashboard-shared ^0.7.0；peer react>=18；devDeps react/@types/react/@types/node/typescript/vitest/fastify/ajv/@testing-library/{react,jest-dom}/jsdom。scripts test=vitest run、typecheck=tsc --noEmit。注意：runtime 导出源 .ts，子路径以 `.js` 结尾解析（如 shared `dashboard-plugin/slot-props.js`）。 |
| `src/client.tsx` | React 客户端入口。`Settings(props: SlotProps<"settings-section">)` 三面板：Matrix 连接表单（homeserver/token(password)/workspace/E2EE/autoConnect + 保存）、配对（trustedUsers 增删 + `isUserMatrixId` 校验 @user:server）、会话状态（REST 轮询 GET /status + 启动/停止/重启 + 日志）。usePluginConfig/usePluginSend；持久化走 plugin_config_write 全量 merge。 |
| `src/server/index.ts` | server 入口。`registerPlugin(ctx, opts?)`（opts=测试注入 seam：spawnImpl/mirrorTarget）：创建 BackgroundSession 接线 broadcast；镜像写 ~/.pi/matrix-bridge.json（配置非空时，best-effort 不致命）；autoConnect+配置完整时自动 start；REST prefix /api/pi-matrix-bridge；registerBrowserHandler replay 广播；`ctx.onEvent` 预留主动推送通道（transport sessionId + trustedUsers 门控）；SIGTERM/SIGINT → detach。读配置用 `ctx.getPluginConfig()`（非 ctx.pluginConfig）。 |
| `src/server/mirror.ts` | `writeBridgeFile(cfg, target=bridgeFilePath())`：写 `~/.pi/matrix-bridge.json` 0600、mkdir recursive；`toBridgeFile` 把 `auth.trustedUsers` 映射 `matrix:` 前缀（桥接文件键名按 README 校准）；`redact()` 输出脱敏 JSON。 |
| `src/server/session.ts` | `BackgroundSession(cfg, spawnImpl=spawn, onState)`：状态机 stopped→running→(stop)stopping→stopped / running→exited；spawn `pi` print 模式 cwd=workspace||homedir，env 注入 PI_MATRIX_BRIDGE_*；start() 校验 homserver+token 完整、workspace existsSync；stop() SIGTERM→5s→SIGKILL；restart()/detach()；日志环形缓冲 200 行；`info():{state,pid,exitReason}`。公共 API 稳定。 |
| `src/types.ts` | 共享类型：`MatrixBridgeConfig` interface、`BridgeState` union（stopped/running/stopping/exited）、`EMPTY_CONFIG` 缺省、`isUserMatrixId(/^@[^:]+:.+$/)`、`matrixUserId(s)=matrix:s`。 |
| `tsconfig.json` | ES2023/ESNext/Bundler，jsx react-jsx，noEmit，strict，types:["node"]，include src。 |
| `vitest.config.ts` | vitest，include test/**/*.test.{ts,tsx}，pool forks maxWorkers 1。jsdom 经文件级 `// @vitest-environment jsdom` + RTL cleanup。 |
| `test/index.test.ts` | vitest 冒烟测试：断言 package.json 的 pi-dashboard-plugin 字段、id、claims、requiredApi。 |
| `test/unit/client.test.tsx` | 4 测试（jsdom + RTL + jest-dom + RTL cleanup）：渲染三面板；添加合法/非法 trusted user（plugin_config_write 校验 + pair-error）；状态面板展示 state/PID/logs。mock dashboard-plugin-runtime/context usePluginConfig/usePluginSend + global.fetch。 |
| `test/unit/mirror.test.ts` | 5 测试：writeBridgeFile 写 tmp 目标、matrix: 前缀、0600 mode、toBridgeFile 形状、redact 不含明文 token、嵌套目录自动创建。 |
| `test/unit/server.test.ts` | 5 测试（ctx stub 注入 spawnImpl+mirrorTarget）：REST prefix + replay handler + mirror 写 matrix: 前缀；autoConnect 完整配置自动 spawn（env 断言）；不完整配置不 spawn + 空配置不建 mirror；onEvent 预留通道 transport sessionId 不可伪造 + 未配对不 forward。 |
| `test/unit/session.test.ts` | 6 测试（注入 fake spawnImpl + FakeChild 触发 exit）：start 调 spawn/env、不完整配置拒绝、workspace 不存在拒绝、stop→stopping→stopped、exit→exited+记录 reason、restart 用最新配置。 |
| `test/unit/types.test.ts` | 4 测试：isUserMatrixId、matrixUserId、EMPTY_CONFIG 缺省。 |

## See change
- openspec/changes/pi-matrix-bridge-plugin/{proposal,specs/matrix-bridge-plugin/spec,design,tasks,plan}.md —— 兼容层完整需求与实现计划。设计含两处可观校准：R7 主动推送改用 `ctx.onEvent`（runtime 的 registerPiHandler 是单参，无 plugin_pi_message 第二参 sessionId）；配置镜像触发点为注册+生命周期动作（runtime 无配置变更订阅）。Status/日志客户端读路径为 REST 轮询（client runtime 无通用 WS 订阅 hook）。See change: e1b3cdd。
