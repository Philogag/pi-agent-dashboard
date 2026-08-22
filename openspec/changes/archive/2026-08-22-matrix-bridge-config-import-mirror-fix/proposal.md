# Proposal: matrix-bridge-config-import-mirror-fix

## Why

`matrix-bridge` 插件的 WebUI 设置页无法加载用户既有的 Matrix 配置。根因：连接配置（homeserver URL、access token）只从 dashboard 插件存储读取（`~/.pi/dashboard/config.json` 的 `plugins.pi-matrix-bridge.*`），而存量配置位于 `~/.pi/matrix-bridge.json`（上游 `pi-matrix-bridge` 扩展的原生 schema：顶层 `matrix` 对象 + `auth.trustedUsers`/`auth.channels`）。插件从不读取该文件 —— 存储中只有 `{enabled: true}`，表单恒为空。

镜像路径同样失效：`toBridgeFile` 写入**扁平**结构 `{homeserverUrl, accessToken, auth:{trustedUsers}}`，而上游扩展只认嵌套的 `config.matrix?.homeserverUrl`（`pi-matrix-bridge/dist/index.js:175`）—— 镜像产物对桌面 pi 不可读，且一次 WebUI 保存会覆盖用户正在使用的有效文件、丢掉扩展写入的每房间权限 `auth.channels`。

**用户决策（方向变更）**：插件配置文件不需要持有连接/配对内容 —— 直接使用 bridge 原生配置文件 `~/.pi/matrix-bridge.json` 作为唯一配置源，设置页读写该文件；删除镜像机制；插件存储瘦身为会话侧字段。

## What Changes

- **删除镜像机制**：`mirror.ts` 不再作为「写一份 dashboard 配置的副本」，改名为 `bridge-file.ts`，职责变为原生文件适配器（读快照 / 展平视图 / 写入嵌套 schema）。
- **设置页直接读写 `~/.pi/matrix-bridge.json`**：
  - 新增 `GET /api/pi-matrix-bridge/config` —— 返回扁平化视图（`matrix.*` 展平为 `homeserverUrl`/`accessToken`、`auth.trustedUsers` 去掉 `matrix:` 前缀），供表单展示；accessToken 明文回显（本地 0600 文件，与扩展自身行为一致）。
  - 新增 `POST /api/pi-matrix-bridge/config` —— 直接写回原生文件：嵌套 `matrix.{homeserverUrl,accessToken}`、`trustedUsers` 加 `matrix:` 前缀、写前合并保留 `auth.channels`、权限 600；成功后刷新内存快照。
- **插件存储瘦身为会话侧字段**：`plugins.pi-matrix-bridge.*` 只保留 `workspace` / `autoConnect` / `encryption`（与生命周期 `enabled`）；不再持久化连接或配对字段；`configSchema.json` 同步收窄。
- **后台会话配置来源**：注册期读取一次原生文件（内存快照）；`BackgroundSession` 的读取器 = 快照连接 + 存储会话侧字段（`session.ts` 零改动）；自动启动判定 = 存储 `autoConnect` 且快照含可用连接（沿用既有判定，输入换为快照）。
- **测试同步**：`test/unit/mirror.test.ts` 更名重写为 `bridge-file.test.ts`（嵌套 schema、前缀、channels 合并、0600、损坏容错）；`test/unit/server.test.ts` 镜像断言改为快照/自动启动断言 + `/config` 端点真实 fastify 用例；`test/unit/client.test.tsx` 配对保存断言从 `plugin_config_write` 改为 `POST /config`。

## Capabilities

### New Capabilities

（无独立新能力 —— 按项目扁平布局，并入既有 `matrix-bridge-plugin` 能力下修改。见下。）

### Modified Capabilities

- `matrix-bridge-plugin`（既有路径 `openspec/specs/matrix-bridge-plugin/spec.md`）：
  - 「配置镜像到本地桥梁配置」需求**删除**，改为「配置直接使用本地桥梁配置」—— 原生文件为唯一连接/配对源，设置页读写该文件，插件存储不再存连接字段；
  - 「配置从本地桥梁文件导入」需求改为「配置初始化自本地桥梁文件」—— 注册期快照加载 + 自动启动判定 + 保存后快照刷新。

## Impact

- **代码**：`packages/pi-matrix-bridge-plugin/src/server/mirror.ts` → 更名/改写为 `bridge-file.ts`（`readBridgeFile` + `flattenBridgeFile` + `writeBridgeConfig` + `stripMatrixPrefix`）；`src/server/index.ts`（删镜像、快照 + `effective()`、`GET`/`POST /config` 端点）；`src/client.tsx`（连接/配对页绑定 `/config` 端点，存储仅会话侧）；`configSchema.json`（收窄）；`test/unit/{bridge-file,server,client}.test.ts(x)`。
- **API**：新增 `GET`/`POST /api/pi-matrix-bridge/config`；`plugin_config_write` 仅用于会话侧字段（语义收窄，端点不变）。
- **依赖**：无新增。
- **规范**：`openspec/specs/matrix-bridge-plugin/spec.md` 重写相关需求与场景。