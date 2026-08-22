# matrix-bridge-plugin Specification

## Purpose
为 `rolznz/pi-matrix-bridge` 提供 pi-dashboard 兼容层：在设置页配置 Matrix 连接与可信用户配对，并自动启动一个带 Matrix 连接、可配置 workspace 的后台 pi 会话，供远程用户在任意 Matrix 客户端与本地 pi 智能体对话。

## Requirements

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
- **THEN** 快照加载，后台 pi 会话以快照连接配置自动启动（spawn 环境注入 `PI_MATRIX_BRIDGE_HOMESERVER` / `PI_MATRIX_BRIDGE_ACCESS_TOKEN` / `PI_MATRIX_BRIDGE_AUTO_CONNECT`；`PI_MATRIX_BRIDGE_AUTO_CONNECT` SHALL 恒为启用 —— 该后台会话专用于 Matrix 通讯，即使插件存储 `autoConnect` 关闭、会话经手动启动，也自动连接 Matrix）

#### Scenario: 文件缺失或无效时静默降级
- **WHEN** `~/.pi/matrix-bridge.json` 不存在、不可读或不含有效连接配置
- **THEN** 系统跳过快照，设置页显示空表单、会话不自动启动、不报错

#### Scenario: 保存后快照刷新
- **WHEN** 用户经设置页保存连接配置成功
- **THEN** 内存快照更新为保存值；随后触发的会话启动/重启使用新值

### Requirement: 后台 pi 会话生命周期管理
系统 SHALL 提供一个随 dashboard server 生命周期管理的「后台 pi 会话」——一个带 Matrix 连接、以 print 模式运行的 `pi` 子进程。当自动连接开启且 Matrix 配置已就绪时，系统 SHALL 在插件注册时自动启动该会话；系统 MUST 允许用户手动启动、停止与重启该会话，并对每个会话维护当前运行状态与进程标识（PID）。

#### Scenario: 插件注册后自动启动
- **WHEN** 插件注册且自动连接开关为开、Matrix 配置完整
- **THEN** 系统自动启动后台 pi 会话，并使其状态变为「运行中」

#### Scenario: 手动停止后再启动
- **WHEN** 用户点击停止按钮，随后点击启动按钮
- **THEN** 系统先终止当前后台会话，再以当前配置启动一个新会话

#### Scenario: 子进程意外退出
- **WHEN** 后台 pi 会话进程因错误意外退出
- **THEN** 系统更新会话状态为「已退出」并记录退出原因，设置页可观察到该状态

### Requirement: 后台会话工作目录可配置
系统 SHALL 以用户配置的 workspace 作为后台 pi 会话的工作目录（`cwd`）启动该会话。当该目录不存在或不可访问时，系统 MUST 拒绝启动并报告原因。

#### Scenario: 使用指定工作区启动
- **WHEN** 用户配置 workspace 为某有效目录并启动后台会话
- **THEN** 后台 pi 会话以该目录作为工作目录运行

#### Scenario: 工作区无效
- **WHEN** 用户配置的 workspace 目录不存在或不可读
- **THEN** 系统拒绝启动会话，并在设置页报告路径无效的原因

### Requirement: 可信用户配对管理
系统 SHALL 在设置页提供用户配对面板，允许用户查看、添加与移除「可信 Matrix 用户」列表（每个条目为一个 Matrix 用户 ID）。该列表 MUST 持久化到 `~/.pi/matrix-bridge.json`（连接与配对的唯一配置文件），以桥接所需的传输命名空间格式（`matrix:@user:server`）存储，使后台会话的矩阵桥接仅接受可信用户。此面板管理的是**用户级**信任（`auth.trustedUsers`）；单个聊天室（channel）的启用与 @提及/仅可信等房间级模式权由 `pi-matrix-bridge` 自身的交互式 DM 命令（`/enable`、`/disable`、`/channels`）处理，不属于本插件范围。

#### Scenario: 添加可信用户
- **WHEN** 用户在配对面板输入 `@alice:example.org` 并确认添加
- **THEN** 该用户 ID 出现在可信用户列表中，且文件中以 `matrix:@alice:example.org` 存储并在后台会话中生效

#### Scenario: 移除可信用户
- **WHEN** 用户从可信用户列表中移除某位用户
- **THEN** 该用户从列表消失，配置被持久化，其后不再被作为可信用户接受

#### Scenario: 非法用户 ID
- **WHEN** 用户输入不符合 `@本地:域名` 格式的字符串
- **THEN** 系统拒绝并提示格式错误，不加入可信用户列表

### Requirement: 会话状态与日志可见
系统 SHALL 通过 WebSocket 将后台 pi 会话的运行状态与实时日志行推送到设置页，使用户无需访问终端即可观察会话行为。初始连接时，系统 SHALL 回放最近的状态与日志以便恢复视图。

#### Scenario: 用户在设置页看到实时日志
- **WHEN** 后台会话输出日志行且设置页处于打开状态
- **THEN** 系统通过 WebSocket 将该日志行实时显示在设置页

#### Scenario: 设置页打开时恢复状态
- **WHEN** 用户打开设置页而后台会话已在运行
- **THEN** 系统回放当前会话状态及最近的日志，使设置页即时呈现当前状态

### Requirement: 会话生命周期 REST API
系统 SHALL 为后台 pi 会话暴露 REST 接口：`GET /api/<plugin-id>/status` 返回当前状态，`POST /api/<plugin-id>/start`、`/stop`、`/restart` 分别执行相应操作。这些接口 MUST 与设置页交互一致：设置页的任何状态变化均由这些接口驱动。

#### Scenario: 查询会话状态
- **WHEN** 客户端调用 `GET /api/pi-matrix-bridge/status`
- **THEN** 系统返回当前会话状态（运行中/已停止/已退出）及进程标识

#### Scenario: 通过 API 重启会话
- **WHEN** 客户端调用 `POST /api/pi-matrix-bridge/restart`
- **THEN** 系统停止当前会话并以其后配置启动新会话，操作完成后状态反映新会话

### Requirement: 其他会话的主动消息推送途径
系统 SHALL 提供一条「由其他 dashboard 会话主动发起」的消息推送途径：任一运行时 pi 会话通过其扩展发出 `plugin_pi_message`（携带本插件约定的消息类型）时，系统 MUST 将该消息递交给本插件的 server 侧处理程序，并附上**来源会话标识**。该来源标识 MUST 取自传输层（会话 socket 键），而非消息体，以防消息体被伪造冒名。系统 MAY 将此类主动消息转发至后台会话/矩阵桥接，但 MUST 仍受可信用户校验约束。

#### Scenario: 其他会话发起主动推送
- **WHEN** 一个非本插件托管的 dashboard 会话通过其扩展发出类型为约定消息的 `plugin_pi_message`
- **THEN** 本插件 server 收到该消息并可从处理程序参数获得来源会话标识，据此决定是否转发

#### Scenario: 来源标识不可伪造
- **WHEN** 收到一条在消息体中自报来源的主动消息
- **THEN** 系统忽略消息体中的来源声明，仅使用传输层提供的会话标识作为来源

### Requirement: 会话归属与多会话隔离
系统 SHALL 在 server 侧以会话标识（sessionId）作为一切事件与消息的归属键：凡来自 pi 会话的事件/消息，MUST 携带该会话的标识；凡发送给 pi 会话的指令（如向后台会话注入提示），MUST 以会话标识为目标。系统 MUST 不得把来自一个会话的内容错误路由到另一个会话。本插件托管的单一后台会话与 dashboard 中其他会话互不串扰。

#### Scenario: 事件按会话归属
- **WHEN** server 同时收到来自不同会话的事件
- **THEN** 系统按各自的会话标识分别处理，不做跨会话串扰，也不混淆后台会话与其他会话

#### Scenario: 定向注入到后台会话
- **WHEN** 需要向后台 pi 会话注入一条提示
- **THEN** 系统以后台会话的标识为目标发送，而不影响其他会话
