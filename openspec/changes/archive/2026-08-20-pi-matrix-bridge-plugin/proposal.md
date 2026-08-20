## Why

当前 `rolznz/pi-matrix-bridge` 是一个注入 pi 进程的扩展：它通过 `sendUserMessage()` 与 `turn_end` 事件把 Matrix 聊天桥接到本地 pi 智能体，让远程用户在任意 Matrix 客户端（Element、FluffyChat 等）与 pi 对话。但它完全由环境变量/`~/.pi/matrix-bridge.json` 配置，并以「systemd 单实例 + 手工 `pi` 命令」的方式在终端外运行——没有仪表盘界面，无法从 pi-dashboard 配置 Matrix 凭据、管理可信用户、或一键拉起/监控一个常驻的、带 Matrix 连接的后台 pi 会话。本变更新增一个 dashboard 插件 `pi-matrix-bridge-plugin`，作为兼容层把这套流程接入 pi-dashboard 的设置页，降低配置与运维成本。

## What Changes

**新增 dashboard 插件 `pi-matrix-bridge-plugin`（独立包，带 `pi-dashboard-plugin` manifest，后续 link/发现接入 dashboard）**

- **server 入口（兼容层/核心）**：在 dashboard 进程内注册 `registerPlugin(ctx)`。拥有并管理一个「后台 pi 会话」子进程（`child_process.spawn` 运行 `pi`，print 模式，`cwd`=可配置的 workspace），把 Matrix 配置以 `PI_MATRIX_BRIDGE_HOMESERVER/ACCESS_TOKEN/AUTO_CONNECT=1` 环境变量喂给该子进程；提供生命周期（start/stop/restart）、PID/状态追踪、`GET /api/<id>/status` 与 `POST /api/<id>/start|stop|restart` REST 路由，并通过 WS 把状态与日志行广播到设置页。
- **settings-section 客户端入口**：在设置页新增一节，含两个面板——(A) Matrix 连接配置（homeserver URL、bot 访问令牌、E2EE 开关、自动连接开关、workspace 路径）与 (B) 用户配对（可信 Matrix 用户 `@user:server` 列表的增删编辑 + 后台会话实时状态/日志）。
- **configSchema.json**：与 manifest 绑定，定义并校验插件配置：`{ matrix:{homeserverUrl,accessToken,encryption}, autoConnect, session:{workspace}, auth:{trustedUsers:[...]} }`。凭据经 `plugin_config_write` 持久化到 dashboard 配置，同时镜像写入 `~/.pi/matrix-bridge.json`（权限 600），使手动运行的桌面 pi（装有该扩展）共享同一配置。
- **不引入 bridge（pi 扩展）入口**：Matrix 桥接本身由 `pi-matrix-bridge` 扩展完成，插件仅做配置/生命周期/状态管理，保持精简。Reason: roleznz/pi-matrix-bridge 已处理实际 Matrix 连接。Impact: 新增一个独立插件包，不影响既有 dashboard 行为（non-breaking）。

## Capabilities

### New Capabilities

- `matrix-bridge-plugin`: dashboard 插件 `pi-matrix-bridge-plugin`，为 `rolznz/pi-matrix-bridge` 提供设置页配置（Matrix 凭据/workspace）、可信用户配对面板，以及一个自动启动、可配置 workspace 的后台 pi 会话的进程管理（启动/停止/重启/状态）。

### Modified Capabilities

<!-- 无既有规范需求变化 -->

## Impact

- **新增**：npm-workspaces monorepo `pi-dashboard-plugins` 内 `packages/pi-matrix-bridge-plugin/`（含 `src/server/index.ts`、`src/client.tsx`、`configSchema.json`、`test/*`）。依赖 `@blackbelt-technology/dashboard-plugin-runtime` 与 `@blackbelt-technology/pi-dashboard-shared`。根 `package.json` 以 `workspaces:["packages/*"]` 统一 install/test/build。
- **运行时**：dashboard server 进程内新增一个 Fastify 插件；管理一个 `pi` 子进程（后台会话）——该进程由插件 spawn，需本机已安装 `pi` 及 `npm:pi-matrix-bridge` 扩展。
- **配置持久化**：写 `~/.pi/dashboard/config.json`（插件配置）与 `~/.pi/matrix-bridge.json`（镜像）。
- **链接方式**：独立包，通过 `npm link` / 后续 node_modules 扫描接入 BlackBeltTechnology/pi-agent-dashboard。
