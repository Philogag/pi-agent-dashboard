## Purpose

为 `rolznz/pi-matrix-bridge` 提供 pi-dashboard 兼容层：在设置页配置 Matrix 连接与可信用户配对，并自动启动一个带 Matrix 连接、可配置 workspace 的后台 pi 会话，供远程用户在任意 Matrix 客户端与本地 pi 智能体对话。

## ADDED Requirements

### Requirement: Matrix 连接配置管理
系统 SHALL 在设置页提供 Matrix 连接配置面板，允许用户读取并修改：homeserver URL、bot 访问令牌（access token）、E2EE 加密开关、自动连接开关，以及后台会话的工作目录（workspace）。修改后的配置 MUST 通过 `plugin_config_write` 持久化到 dashboard 的插件配置，并立即生效于后续后台会话启动。

#### Scenario: 用户在设置页保存 Matrix 配置
- **WHEN** 用户在设置页填写 homeserver URL 与 access token 并点击保存
- **THEN** 系统将配置持久化，并提示保存成功，后续启动的后台会话使用该配置连接 Matrix

#### Scenario: 配置缺省值
- **WHEN** 用户在未填写任何 Matrix 配置时查看设置页
- **THEN** 系统以默认值或缺省展示，不因缺少配置而报错

### Requirement: 配置镜像到本地桥梁配置
系统 SHALL 在每次 Matrix 连接配置被持久化时，将等效配置镜像写入用户主目录下的 `~/.pi/matrix-bridge.json`，且该文件写入权限 MUST 为 600（仅当前用户可读写），使手动运行的、安装了 `pi-matrix-bridge` 扩展的桌面 pi 共享同一配置。

#### Scenario: 保存配置后同步镜像文件
- **WHEN** 用户在设置页保存 Matrix 连接配置
- **THEN** 系统将相同配置写入 `~/.pi/matrix-bridge.json`，文件权限为 600

#### Scenario: 镜像失败
- **WHEN** 系统无法写入 `~/.pi/matrix-bridge.json`（如权限不足或磁盘错误）
- **THEN** 系统记录错误并在设置页提示配置文件镜像失败，但不阻断插件配置本身的持久化

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
系统 SHALL 在设置页提供用户配对面板，允许用户查看、添加与移除「可信 Matrix 用户」列表（每个条目为一个 Matrix 用户 ID）。该列表 MUST 持久化为插件配置的一部分，并在镜像到 `~/.pi/matrix-bridge.json` 时以桥接所需的传输命名空间格式（`matrix:@user:server`）存储，使后台会话的矩阵桥接仅接受可信用户。此面板管理的是**用户级**信任（`auth.trustedUsers`）；单个聊天室（channel）的启用与 @提及/仅可信等房间级模式权由 `pi-matrix-bridge` 自身的交互式 DM 命令（`/enable`、`/disable`、`/channels`）处理，不属于本插件范围。

#### Scenario: 添加可信用户
- **WHEN** 用户在配对面板输入 `@alice:example.org` 并确认添加
- **THEN** 该用户 ID 出现在可信用户列表中，配置被持久化，且镜像文件中以 `matrix:@alice:example.org` 存储并在后台会话中生效

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
