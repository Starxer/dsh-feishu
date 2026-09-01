# chatterbox4dsh — 陪 DeepSeek Harness 用的唠叨型飞书/Lark 插件

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 agent 能力接入飞书/Lark 聊天，并把 **agent 的每一步都唠叨给你看**（推理、工具调用、结果、时长/token）。安装后，用户直接从飞书与 Harness Agent 对话，共享 DSH 的模型、工具、工作区和会话存储。

> **定位**：`chatterbox4dsh`（chatterbox = 唠叨话痨）只做"DSH 原生特性 → 飞书聊天"这一层接入，**DSH 本身才是 agent 本体**。我们不做一个独立的 agent 平台或 24h 常驻助手——那是另一个产品。飞书和 DSH Web UI 共享同一套服务，飞书只是多出一个聊天端口。
>
> **设计理念**：功能对齐优先于功能创新。新增能力前先对照 DSH Web UI 是否有同名/等价能力，有则对齐，无再讨论。
>
> **差异化**：step 级过程透明——每个 step 一张三段式卡片（💬 Reasoning / 📝 Message / 🛠 Tool call + 结果 + 时长/token footer），在弱模型下也能观察 Agent 行为并即时干预（`/steer` `/stop`），其余 IM 桥接多收敛到"结果交付/审批"。

## 功能

| 能力 | 说明 |
|---|---|
| 单聊 / 群聊 / 话题群 | 单聊和群聊按聊天复用 Session；话题群按线程独立 Session |
| 统一 per-step 卡片 | 每个 agent step 一张卡片，包含推理、文本、工具调用、结果预览、时长和 token 统计 |
| 工具调用展示 | 工具名内联代码 + args（独立 fenced 代码块防溢出）+ 结果预览（terminal/web/search/read/diff），原地更新 wathet→green/red |
| Turn Complete 卡片 | turn 结束后展示总时长/LLM 时间/工具时间、TTFT/吞吐量、token/缓存命中率，footer 另显示 **Enter while busy** |
| 会话管理面板 | `/session`：交互式卡片下拉选会话 + 切换/detach/归档/fork/改名/列表/刷新；`/session list` 表格卡；`/session N` 快速切换 |
| 斜杠命令 | `/model` `/new` `/session` `/status` `/stop` `/steer` `/queue` `/busy` `/permission` `/reasoning` `/approve` `/deny` `/help` 等 |
| 审批 | 与 DSH Web UI 共享同一份 pending 审批状态；审批卡片 **Approve 在上 / Reject 在下**，并显示 `Reason:` 原因 |
| `ask_user_question` 卡片 | 问题卡片（选项/自定义输入/跳过），一次多问时**顺序迭代**、整批返回答案 |
| 图片 / 文件接收 | 图片按**真实字节判型**（PNG/JPEG/WebP/GIF）经 attachment store 落盘；文件下载到**会话工作区 `.feishu-inbox/`** 供 agent 读取 |
| agent 主动发文件 | `feishu_send_file` 模型工具：agent 可把工作区文件推送到当前飞书聊天（≤30MB） |
| agent 接收文件 | `feishu_receive_file` 模型工具：agent 按需/兜底直接下载入站飞书文件到同一工作区 `.feishu-inbox/` |
| 运行中注入 steer | `/steer <内容>` 一次性注入当前 turn；`/busy steer` 可把"运行中发消息"默认设为注入（持久化）；agent 空闲时 `/steer`/`/queue` 自动回退为发新消息 |
| 运行中排队（/queue） | `/queue <内容>` 强制走 queue 路径（即使处于 steer 模式）作为新一轮运行；空闲时回退为发新消息 |
| 权限模式选择 | `/permission`：查看/切换会话权限（沙箱）模式，名称与显示名对齐 WebUI（Read Only / Workspace Write / Full access），**交互式卡片**点选切换 |
| 报错带具体原因 | 出错回报带具体原因与错误码（`errorText`），不再只回统一道歉文案 |
| WebSocket 长连接 | 无需公网服务器，支持飞书中国版和国际版 Lark |
| 访问控制 | 群聊白名单、单聊白名单、@机器人 要求 |

## 安装

```sh
npx @deepseek-ai/dsh plugin --profile web add @starxer/chatterbox4dsh
```

然后在 DSH **Settings** → 飞书与 Lark 中配置 App ID 和 App Secret。支持扫码一键配置（推荐）或手动创建应用。

详见 [docs/feishu-setup.md](docs/feishu-setup.md)。

## 快速开始

1. 安装插件（上方命令）
2. 启动 DSH：`npx @deepseek-ai/dsh web`
3. 在 Settings → 飞书与 Lark 中配置应用凭据
4. 在飞书中找到机器人，发送消息即可

## 斜杠命令

| 命令 | 说明 |
|---|---|
| `/model [list\|<provider>/<model>]` | 查看/列出/切换模型 |
| `/new [--workspace <path>] [--preset <id>]` | 新建会话（可指定工作区和 preset） |
| `/session [N\|list]` | 无参：交互式会话管理面板；`list`：表格；`N`：按下标快速切换 |
| `/status` | 展示会话状态（token/TTFT/吞吐量/缓存命中率/权限模式/Enter while busy 等） |
| `/reasoning [off\|low\|high\|max]` | 设置推理强度 |
| `/stop` | 中止当前轮次并丢弃排队消息（不再进入下一 turn） |
| `/steer <内容>` | agent 运行中，把一条消息注入当前 turn；**空闲时自动回退为发新消息** |
| `/queue <内容>` | /steer 的共轭：强制把消息排队为新轮（即使处于 steer 模式）；空闲时回退为发新消息 |
| `/busy [queue\|steer]` | 设置运行中（busy）的 Enter 行为：排队发送（默认）或插话发送，**持久化** |
| `/permission [模式]` | 查看/切换会话权限（沙箱）模式；无参发交互式选择卡片 |
| `/approve` `/deny` `/approvals` | 处理工具审批 |
| `/help` | 卡片列出所有可用命令（分组：chatterbox4dsh 插件 / DSH 内置） |

> **运行中发消息的行为（`/busy`）**：`queue`（排队发送，等待当前轮结束后作为新轮运行）或 `steer`（插话发送，注入当前轮立即响应，persist）。`/status` 的 **Enter while busy** 行显示当前值。一次性插话用 `/steer <内容>`；一次性排队用 `/queue <内容>`。**agent 空闲时**，`/steer`、`/queue` 都会自动回退为「作为新消息发送」而不是报错。`/stop` 会中止当前轮并**丢弃排队/等待中的消息**（不再自动进入下一 turn）。

## 配置

```yaml
- id: lark-channel
  config:
    appId: cli_xxxxxxxxxxxxxxxx
    appSecretRef: DSH_LARK_APP_SECRET
    domain: feishu              # feishu（中国版）或 lark（国际版）
    requireMention: true         # 群聊是否必须 @机器人
    dmMode: open                 # open / allowlist / disabled
    workspace: /path/to/project  # 默认工作区
    agentPreset: coding          # 默认 agent preset
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `appId` | — | 飞书应用 App ID |
| `appSecretRef` | `DSH_LARK_APP_SECRET` | Harness Credentials 中的 Secret 引用名 |
| `domain` | `feishu` | `feishu` 或 `lark` |
| `requireMention` | `true` | 群聊是否必须 @机器人 |
| `dmMode` | `open` | 单聊策略：`open` / `allowlist` / `disabled` |
| `groupAllowlist` | `[]` | 允许的群 chat_id 列表 |
| `dmAllowlist` | `[]` | allowlist 模式下的用户 open_id 列表 |
| `provider` / `model` | Harness 默认 | 为飞书渠道指定模型 |
| `workspace` | 第一个注册的 Workspace | Agent 工作目录 |
| `agentPreset` | Harness 默认 Preset | Agent preset |
| `reactEmoji` | `THUMBSUP` | 收到消息时的表情回应（空字符串关闭） |

## 架构

```
飞书用户 → Lark SDK (WebSocket) → chatterbox4dsh → Harness Agent → 回复卡片
```

插件运行在 DSH Host 内部，不启动额外进程，不暴露 HTTP 端点。每个飞书聊天映射一个 DSH Session，Agent 在 turn 完成后复用。

详见 [docs/architecture.md](docs/architecture.md)。

## 开发

```sh
npm install
npm test
npm run build
```

修改源码后：`npm run build && systemctl --user restart dsh`

## 上游来源

基于 [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark)（`ee639df`）fork，**已独立维护**，不再跟踪上游同步。详见 [AGENTS.md](AGENTS.md)。

## License

MIT — Copyright (c) 2026 sugarforever（上游），modified work by Starxer。
