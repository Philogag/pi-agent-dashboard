# matrix-bridge-plugin Specification (Delta)

## MODIFIED Requirements

### Requirement: 配置直接使用本地桥梁配置
`~/.pi/matrix-bridge.json` SHALL 是 Matrix 连接与配对配置的**唯一持久化来源**（上游 `pi-matrix-bridge` 扩展原生 schema：顶层 `matrix.{homeserverUrl,accessToken}` 与 `auth.{trustedUsers,channels}`）。系统 SHALL 经插件 REST 端点（`GET /api/pi-matrix-bridge/config`）读取该文件并以扁平化视图呈现给设置页（`matrix.*` 展平、`auth.trustedUsers` 去除 `matrix:` 传输前缀），access token SHALL 明文回显以便修改（文件权限 600，仅当前用户可读写）。设置页保存 SHALL 经 `POST /api/pi-matrix-bridge/config` 直接写回该文件：连接字段 MUST 以嵌套 `matrix.*` 结构存储，可信用户 MUST 以 `matrix:@user:server` 传输命名空间格式存储，写入前 MUST 读取并合并保留文件中已有的每房间权限数据 `auth.channels`（不得丢失扩展 DM 命令 `/channels` 等写入的房间级模式），文件权限 MUST 为 600。dashboard 插件存储（`plugins.pi-matrix-bridge.*`）SHALL 只承载会话侧字段（`workspace` / `autoConnect` / `encryption`，以及生命周期 `enabled`），不得再持久化连接或配对字段；`configSchema.json` MUST 与之一致（收窄）。

#### Scenario: 设置页显示文件配置
- **WHEN** `~/.pi/matrix-bridge.json` 含有效连接配置，用户打开设置页
- **THEN** 设置页显示文件的 homeserver URL、access token（回显）与可信用户列表（去除 `matrix:` 前缀），不产生 `plugin_config_write`

#### Scenario: 保存配置写入文件
- **WHEN** 用户在设置页保存连接或配对配置（含新增/移除可信用户）
- **THEN** `~/.pi/matrix-bridge.json` 更新：连接字段位于顶层 `matrix` 对象内，`auth.trustedUsers` 以 `matrix:` 前缀存储，既存 `auth.channels` 内容保持不变，文件权限为 600

#### Scenario: 写入文件失败
- **WHEN** 系统无法写入 `~/.pi/matrix-bridge.json`（如权限不足或磁盘错误）
- **THEN** 系统返回错误并在设置页提示写入失败，不写入插件存储

### Requirement: 配置初始化自本地桥梁文件
系统 SHALL 在插件注册期读取 `~/.pi/matrix-bridge.json` 一次并保存在内存快照中，作为后台会话启动决策与设置页视图的连接来源；该文件缺失、不可读或无效（无有效的顶层 `matrix` 连接对象）时，系统 MUST 静默降级 —— 设置页显示空表单、不发生自动启动、不报错、不产生日志噪音。后台会话的自动启动判定 SHALL 为：插件存储 `autoConnect` 为真 且 快照含可用连接（`matrix.homeserverUrl` 与 `matrix.accessToken` 均非空）；会话启动配置 SHALL 取快照连接字段与插件存储会话侧字段的合并视图。设置页经 `POST /api/pi-matrix-bridge/config` 保存成功后，系统 SHALL 刷新内存快照，使后续会话启动/重启使用新值。

#### Scenario: 注册期快照加载并可自动启动
- **WHEN** 文件有效且插件存储 `autoConnect` 为真（含默认值）
- **THEN** 快照加载，后台 pi 会话以快照连接配置自动启动（spawn 环境注入 `PI_MATRIX_BRIDGE_HOMESERVER` / `PI_MATRIX_BRIDGE_ACCESS_TOKEN` / `PI_MATRIX_BRIDGE_AUTO_CONNECT`）

#### Scenario: 文件缺失或无效时静默降级
- **WHEN** `~/.pi/matrix-bridge.json` 不存在、不可读或不含有效连接配置
- **THEN** 系统跳过快照，设置页显示空表单、会话不自动启动、不报错

#### Scenario: 保存后快照刷新
- **WHEN** 用户经设置页保存连接配置成功
- **THEN** 内存快照更新为保存值；随后触发的会话启动/重启使用新值

## DELETED Requirements

### Requirement: 配置镜像到本地桥梁配置
（删除 —— 镜像机制整体移除：「配置直接使用本地桥梁配置」取代其职责，连接/配对配置直接读写原生文件，不再存在「dashbboard 存储 → 镜像文件」的副本路径。）