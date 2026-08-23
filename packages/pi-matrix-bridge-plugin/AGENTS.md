# DOX — packages/pi-matrix-bridge-plugin/

@blackbelt-technology/pi-matrix-bridge-plugin。仪表盘插件，为 rolznz/pi-matrix-bridge 提供兼容层：
server 入口（`registerPlugin(ctx)`）直接 `child_process.spawn` 一个后台 pi 子进程（`--mode rpc` 无头会话；
workspace 可配），连接/配对以 `~/.pi/matrix-bridge.json` 原生文件为单一事实源（注册期快照 + 保存回写 0600，
`trustedUsers` 加 `matrix:` 前缀），插件存储只留会话侧字段（workspace/autoConnect/encryption）。
session 启动成功后 connect 控制器经 rpc stdin 推送 `/matrix-bridge connect` → 轮询
`~/.pi/matrix-bridge.lock` 确认连接 → 推送初始化测试 prompt → 以 REST（fetch）DM 已配对用户。
REST: GET/POST `/api/pi-matrix-bridge/{status,config,start,stop,restart}`；状态经
`ctx.broadcastToSubscribers({type:"pi-matrix-bridge_status",info,logs})` 推送。
Manifest id `pi-matrix-bridge`，requiredApi `^0.7.0`；bridge 入口刻意不用（server 直接 spawn pi）。
主动推送：预留 `ctx.onEvent((sessionId,event))` 观察通道（不可伪造 sessionId + trustedUsers 门控），未接转发。

| File | Purpose |
|------|---------|
| `README.md` | 使用/开发/测试说明；前置依赖（pi 命令 + npm:pi-matrix-bridge）、env 覆盖文件配置说明、首次启用步骤。 |
| `configSchema.json` | JSON Schema 7 配置 schema：properties homeserverUrl{string}/accessToken{string}/encryption{boolean,default:true}/autoConnect{boolean,default:true}/session{object,workspace{string}}/auth{object,trustedUsers{array string}}；required 全字段；additionalProperties:false。 |
| `package.json` | 插件包元数据 + 顶层 `pi-dashboard-plugin` manifest（client/client.tsx、server/server/index.ts、configSchema、claims:[settings-section→Settings]）。deps dashboard-plugin-runtime + pi-dashboard-shared ^0.7.0；peer react>=18；devDeps react/@types/react/@types/node/typescript/vitest/fastify/ajv/@testing-library/{react,jest-dom}/jsdom。scripts test=vitest run、typecheck=tsc --noEmit。注意：runtime 导出源 .ts，子路径以 `.js` 结尾解析（如 shared `dashboard-plugin/slot-props.js`）。 |
| `src/client.tsx` | React 客户端入口。`Settings(props: SlotProps<"settings-section">)` 三面板：Matrix 连接表单（homeserver/token(password)/workspace/E2EE/autoConnect + 保存）、配对（trustedUsers 增删 + `isUserMatrixId` 校验 @user:server）、会话状态（REST 轮询 GET /status + 启动/停止/重启 + 日志）。连接/配对经 `GET/POST /api/pi-matrix-bridge/config` 直连原生文件 `~/.pi/matrix-bridge.json`（conn state）；`plugin_config_write` 只写会话侧字段（workspace/autoConnect/encryption）。 |
| `src/server/index.ts` | server 入口。`registerPlugin(ctx, opts?)`（opts=测试注入 seam：spawnImpl/filePath/connect）：注册期 `readBridgeFile` 快照 `fileValues` + 同步 `effective()` getter（原生文件连接/配对 + 存储会话侧，trustedUsers 去重剥前缀）；autoConnect+快照连接可用时自动 start；每次 start 成功后 launchConnect() 调 runConnectController（opts.connect 可注入）；REST prefix /api/pi-matrix-bridge（/status；/config GET+POST；/start /stop /restart）；registerBrowserHandler replay 广播；`ctx.onEvent` 预留主动推送通道（transport sessionId + effective 门控）；SIGTERM/SIGINT → detach。读配置用 `ctx.getPluginConfig()`。 |
| `src/server/bridge-file.ts` | `~/.pi/matrix-bridge.json` 原生适配器（连接+配对单一事实源）：`readBridgeFile` 快照（缺失/无效→null）、`flattenBridgeFile` 展平视图（去 matrix: 前缀）、`writeBridgeConfig` 嵌套 matrix.* 写入 + channels 合并 + 0600（`BridgeConfigError`）、`stripMatrixPrefix`。 |
| `src/server/connect-controller.ts` | 连接控制器 `runConnectController(session, opts)`：session 启动成功后驱动 —— rpc stdin 推送 `/matrix-bridge connect`（id matrix-connect）→ `waitForLock`(~/.pi/matrix-bridge.lock) 确认连接（超时→warn 但继续）→ 推送初始化 prompt（id matrix-init-prompt，默认「【连接测试】…请回复一句简短的测试消息」）→ 逐 trustedUser `notifyMatrixUser` DM（连接成功=「✅ Matrix 桥已连接」，超时=警告文案）。opts 可注入 lockPath/轮询/超时/文案/logger；永不 throw。 |
| `src/server/matrix-notify.ts` | 一次性 Matrix DM（纯 REST fetch，`notifyMatrixUser({homeserverUrl,accessToken,userId,text})`）：POST createRoom（preset trusted_private_chat + invite + is_direct）→ POST send/m.room.message；URI 去尾斜杠 + userId 剥 matrix: 前缀；任何失败→false（调用方记 warn）。刻意不用 matrix-bot-sdk（Request 时代依赖树与 pnpm 严格 hoisting 不兼容）。 |
| `src/server/session.ts` | `BackgroundSession(cfg, spawnImpl=spawn, onState)`：状态机 stopped→running→(stop)stopping→stopped / running→exited；spawn `pi ["--mode","rpc"]` cwd=workspace||homedir，env 仅注入 PI_DASHBOARD_SPAWNED=1（连接不经 env，由控制器经 stdin 驱动）；`sendRpc(message,id?)` 向孩子 stdin 写 JSONL `{"type":"prompt",...}`（无孩子时 no-op）；start() 校验 homserver+token 完整、workspace existsSync；stop() SIGTERM→5s→SIGKILL；restart()/detach()；日志环形缓冲 200 行；`info():{state,pid,exitReason}`。公共 API 稳定。 |
| `src/types.ts` | 共享类型：`MatrixBridgeConfig` interface、`BridgeState` union（stopped/running/stopping/exited）、`EMPTY_CONFIG` 缺省、`isUserMatrixId(/^@[^:]+:.+$/)`、`matrixUserId(s)=matrix:s`。 |
| `tsconfig.json` | ES2023/ESNext/Bundler，jsx react-jsx，noEmit，strict，types:["node"]，include src。 |
| `vitest.config.ts` | vitest，include test/**/*.test.{ts,tsx}，pool forks maxWorkers 1。jsdom 经文件级 `// @vitest-environment jsdom` + RTL cleanup。 |
| `test/index.test.ts` | vitest 冒烟测试：断言 package.json 的 pi-dashboard-plugin 字段、id、claims、requiredApi。 |
| `test/unit/client.test.tsx` | 4 测试（jsdom + RTL + jest-dom + RTL cleanup）：渲染三面板；添加合法/非法 trusted user（plugin_config_write 校验 + pair-error）；状态面板展示 state/PID/logs。mock dashboard-plugin-runtime/context usePluginConfig/usePluginSend + global.fetch。 |
| `test/unit/bridge-file.test.ts` | 8 测试：readBridgeFile 解析/缺失/损坏/无效→null、stripMatrixPrefix、flattenBridgeFile 展平+剥前缀、writeBridgeConfig 嵌套+前缀+0600+channels 保留+mkdir、连接全空无文件→BridgeConfigError。 |
| `test/unit/connect-controller.test.ts` | 4 测试（fake sendRpc + stub fetch + 真实临时锁文件）：lock 出现→resolves true；超时→false；完整流程（connect cmd 顺序、每用户 createRoom+send、Bearer、矩阵: 前缀剥离、成功文案）；锁超时→warn+仍发 init prompt+警告 DM；连接不完整→不发 DM。 |
| `test/unit/matrix-notify.test.ts` | 5 测试（stub fetch）：createRoom+send 成功（URL/方法/Bearer/invite/body）与梯形；matrix: 前缀剥离；createRoom 403→false 不 send；send 500→false；fetch throw→false。 |
| `test/unit/server.test.ts` | 8 测试（ctx stub 注入 spawnImpl+connect seam）：REST prefix + replay handler + 无配置不建文件；有文件自动 start（env 断言 PI_DASHBOARD_SPAWNED=1、无 PI_MATRIX_BRIDGE_*、connect 控制器被调一次）；无文件不 start 不 connect；/config GET 展平视图 + POST 嵌套写盘 + 快照刷新 + 无文件空连接 400。onEvent 预留通道 transport sessionId 不可伪造 + 未配对不 forward。 |
| `test/unit/session.test.ts` | 9 测试（注入 fake spawnImpl + FakeChild 触发 exit）：start 调 spawn rpc 参数/env、不完整配置拒绝、workspace 不存在拒绝、stop→stopping→stopped、exit→exited+记录 reason、restart 用最新配置、sendRpc JSONL（带/不带 id）、sendRpc 无孩子 no-op。 |
| `test/unit/types.test.ts` | 4 测试：isUserMatrixId、matrixUserId、EMPTY_CONFIG 缺省。 |

## See change
- openspec/changes/pi-matrix-bridge-plugin/{proposal,specs/matrix-bridge-plugin/spec,design,tasks,plan}.md —— 兼容层完整需求与实现计划。设计含两处可观校准：R7 主动推送改用 `ctx.onEvent`（runtime 的 registerPiHandler 是单参，无 plugin_pi_message 第二参 sessionId）；配置镜像触发点为注册+生命周期动作（runtime 无配置变更订阅）。Status/日志客户端读路径为 REST 轮询（client runtime 无通用 WS 订阅 hook）。See change: e1b3cdd。
