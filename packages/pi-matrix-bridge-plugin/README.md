# @blackbelt-technology/pi-matrix-bridge-plugin

Pi Matrix Bridge — pi-dashboard 插件，为 [`rolznz/pi-matrix-bridge`](https://github.com/rolznz/pi-matrix-bridge)
提供兼容层：直接在 dashboard 设置页配置 Matrix 连接、配对可信用户，并托管一个后台 pi 会话
（读取该扩展、通过 Matrix 与远程用户对话），无需手动改 `~/.pi/matrix-bridge.json` 或用 systemd 拉起。

## 前置依赖

- `pi` 命令在 PATH 上（后台会话用 `child_process.spawn("pi", ["print"])` 拉起）。
- 已安装 `pi-matrix-bridge` 扩展：`pi install npm:@blackbelt-technology/pi-matrix-bridge`（或等价来源）。

## 它做什么

- **设置页**（Settings → Pi Matrix Bridge）三块面板：
  - Matrix 连接配置（homeserver URL、access token、E2EE、自动连接、后台会话 workspace）。
  - 可信用户配对（增删 `@user:server`，格式校验）。
  - 后台会话状态/日志 + 启动/停止/重启。
- **配置持久化**：连接/配对配置直接存于原生桥接文件 `~/.pi/matrix-bridge.json`
  （上游扩展 schema：顶层 `matrix.*` + `auth.trustedUsers` 带 `matrix:` 前缀；chmod 600）。
  设置页经 `GET/POST /api/pi-matrix-bridge/config` 读写该文件；插件存储
  （`~/.pi/dashboard/config.json` 的 `plugins.pi-matrix-bridge.*`）只承载会话侧字段
  （workspace/autoConnect/encryption），经 `plugin_config_write` 持久化。
- **后台会话**：一个 `pi` 子进程（print 模式），cwd 可配置；环境注入
  `PI_MATRIX_BRIDGE_HOMESERVER` / `PI_MATRIX_BRIDGE_ACCESS_TOKEN` / `PI_MATRIX_BRIDGE_AUTO_CONNECT`。
  自动连接（autoConnect=true 且配置完整）时随插件注册自动启动；进程意外退出会在状态面板可见。

## 环境变量 vs 文件配置

`pi-matrix-bridge` 支持用环境变量 `PI_MATRIX_BRIDGE_HOMESERVER`、`PI_MATRIX_BRIDGE_ACCESS_TOKEN`
**覆盖** 文件 `~/.pi/matrix-bridge.json`。本插件以 spawn 子进程并把这两个 env 注入后台会话；
WebUI 保存时直接把配置写入文件（而非镜像），两者因此保持一致。手动直接运行 `pi` 时
则靠文件里的配置生效（env 覆盖仅当显式设置时）。

## 首次启用

1. 在 Settings → Pi Matrix Bridge 填 homeserver URL + access token（建议勾选 E2EE、自动连接），
   点「保存连接配置」。
2. 在「可信用户」添加要让它对话的 Matrix 用户，如 `@alice:example.org`（校验 `@user:server` 格式）。
3. 检查「会话状态」面板：autoConnect 已开则自动 running；否则点「启动」。

## Develop

```bash
npm install
npm test --workspace @blackbelt-technology/pi-matrix-bridge-plugin   # vitest
npm run typecheck --workspace @blackbelt-technology/pi-matrix-bridge-plugin
```

## Config

插件配置在 `~/.pi/dashboard/config.json` 的 `plugins.pi-matrix-bridge.*`，schema 见 `configSchema.json`，
类型见 `src/types.ts`。读：`usePluginConfig<MatrixBridgeConfig>()`；写：`usePluginSend()` 发
`{ type: "plugin_config_write", id: "pi-matrix-bridge", config: { ... } }`。
服务端读：`ctx.getPluginConfig<MatrixBridgeConfig>()`。

## See also

- 上游桥接：https://github.com/rolznz/pi-matrix-bridge
- 运行时：`@blackbelt-technology/dashboard-plugin-runtime`
- 本插件 server/client 内部 API 见仓库 `AGENTS.md`（per-file rows）。
