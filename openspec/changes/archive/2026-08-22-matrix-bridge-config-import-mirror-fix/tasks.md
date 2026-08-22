# Tasks: matrix-bridge-config-import-mirror-fix

实现清单。`superpower-plan.md` 为每个任务的精确代码与步骤（tc: 本文件与之一一对应）。Spec: `specs/matrix-bridge-plugin/spec.md`（「配置直接使用本地桥梁配置」+「配置初始化自本地桥梁文件」）。

## 1. 原生文件适配器（bridge-file.ts）

- [x] 1.1 将 `src/server/mirror.ts` 与 `test/unit/mirror.test.ts` 通过 `git mv` 更名/重写到 `bridge-file.ts` / `bridge-file.test.ts`，并按 superpower-plan Task 1 Step 1 重写测试（readBridgeFile 缺失/损坏/无效→null、flattenBridgeFile 展平+剥前缀、stripMatrixPrefix、writeBridgeConfig 嵌套写出+matrix: 前缀+channels 保留+0600+mkdir、连接全空无文件→BridgeConfigError），验证 `npx vitest run test/unit/bridge-file.test.ts` 先红
- [x] 1.2 按 superpower-plan Task 1 Step 3 实现 `src/server/bridge-file.ts`（`readBridgeFile` / `flattenBridgeFile` / `stripMatrixPrefix` / `BridgeConfigError` / `writeBridgeConfig`），验证 `npx vitest run test/unit/bridge-file.test.ts` 全绿
- [x] 1.3 更新 `packages/pi-matrix-bridge-plugin/AGENTS.md`（mirror.ts/mirror.test.ts 行 → bridge-file 行）并提交 commit（消息见 superpower-plan Task 1 Step 5）

## 2. 注册期快照 + 删除镜像 + effective() 会话配置

- [x] 2.1 更新 `test/unit/server.test.ts`：`makeCtx` 增 fastify 覆写参；`mirrorTarget` → `filePath`；删镜像断言（改为「无文件不写文件」）；新增「auto-start 从原生文件」与「无可用文件不自动启动」用例；验证先红
- [x] 2.2 实现 `src/server/index.ts`：删 `runMirror`/`MIRROR_ERROR_TYPE`/`mirrorTarget`；注册期 `let fileValues = await readBridgeFile(...)`；同步 `effective()` = 快照连接 + `readConfig()` 会话侧（trustedUsers 去重，matrix: 前缀剥离）；`BackgroundSession(effective, ...)`；自动启动判定 `autoConnect && homeserverUrl && accessToken`；转发门用 `effective().auth.trustedUsers`；验证 `npx vitest run test/unit/server.test.ts test/unit/session.test.ts` 全绿并提交

## 3. GET/POST /api/pi-matrix-bridge/config 端点

- [x] 3.1 按 superpower-plan Task 3 Step 1 在 `test/unit/server.test.ts` 新增 real-fastify 用例（GET 展平视图含前缀剥离与存储会话侧值；POST 写嵌套文件+channels 保留+快照刷新后 GET 一致；E10 无文件连接全空→400），验证先红
- [x] 3.2 实现 `GET /config`（`{ ok: true, ...effective() }`）与 `POST /config`（body `{homeserverUrl, accessToken, trustedUsers}` → `writeBridgeConfig` → 刷新 `fileValues` → 返回更新视图；`BridgeConfigError`→400、写盘失败→500+日志），验证 `npx vitest run test/unit/server.test.ts` 全绿并提交

## 4. 插件存储瘦身 + 客户端绑定 /config

- [x] 4.1 重写 `test/unit/client.test.tsx`：fetch mock 按 URL 路由；配对 addUser 改断言 `POST /config`（不再 `plugin_config_write`）；新增「GET /config 种入连接+配对」用例；无效用户不 POST；验证先红
- [x] 4.2 实现 `src/client.tsx`：新增 `conn`/`connError` 状态 + 挂载 `GET /config` 种入（连接+配对绑定 `conn`）；水合 `hasData` 收窄为会话侧；`saveConnection` = `POST /config` + `plugin_config_write`（仅 `{autoConnect, encryption, session:{workspace}}`）；`addUser`/`removeUser` 改 `POST /config`；`connError` 渲染；验证 `npx tsc --noEmit && npx vitest run test/unit/client.test.tsx` 通过
- [x] 4.3 收窄 `configSchema.json` 为会话侧三键（`autoConnect`/`encryption`/`session.workspace`，required 一致，`additionalProperties: false`），验证 schema JSON 可解析且无连接/配对键，并提交（commit 消息见 superpower-plan Task 4 Step 5）

## 5. 全量回归与文档同步

- [x] 5.1 运行 `cd packages/pi-matrix-bridge-plugin && npx vitest run` 全绿，且根目录 `npm test` 无本包相关回归
- [x] 5.2 运行 `openspec validate --changes` 通过（`✓ change/matrix-bridge-config-import-mirror-fix`），并把 design.md/superpower-design.md 与落地代码的对齐差异就地修正（如有）后提交