# dsh-feishu — DeepSeek Harness 飞书/Lark 插件

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 agent 能力接入飞书/Lark 聊天。安装后，用户直接从飞书与 Harness Agent 对话，共享 DSH 的模型、工具、工作区和会话存储。

> **定位**：dsh-feishu 只做"DSH 原生特性 → 飞书聊天"这一层接入，**DSH 本身才是 agent 本体**。我们不做一个独立的 agent 平台或 24h 常驻助手——那是另一个产品。飞书和 DSH Web UI 共享同一套服务，飞书只是多出一个聊天端口。
>
> **设计理念**：功能对齐优先于功能创新。新增能力前先对照 DSH Web UI 是否有同名/等价能力，有则对齐，无再讨论。

## 功能

| 能力 | 说明 |
|---|---|
| 单聊 / 群聊 / 话题群 | 单聊和群聊按聊天复用 Session；话题群按线程独立 Session |
| 统一 per-step 卡片 | 每个 agent step 一张卡片，包含推理、文本、工具调用、结果预览、时长和 token 统计 |
| 工具调用展示 | 工具名内联代码 + args + 结果预览（terminal/web/search/read/diff），原地更新 wathet→green/red |
| Turn Complete 卡片 | turn 结束后展示总时长/LLM 时间/工具时间、TTFT/吞吐量、token/缓存命中率 |
| 斜杠命令 | `/model` `/new` `/thread` `/status` `/stop` `/reasoning` `/approve` `/deny` 等 |
| 审批 | 与 DSH Web UI 共享同一份 pending 审批状态 |
| WebSocket 长连接 | 无需公网服务器，支持飞书中国版和国际版 Lark |
| 访问控制 | 群聊白名单、单聊白名单、@机器人 要求 |

## 安装

```sh
npx @deepseek-ai/dsh plugin --profile web add @starxer/dsh-feishu
```

然后在 DSH Settings → 飞书与 Lark 中配置 App ID 和 App Secret。支持扫码一键配置（推荐）或手动创建应用。

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
| `/thread [N]` | 列出/切换会话 |
| `/status` | 展示会话状态（token/TTFT/吞吐量/缓存命中率等） |
| `/reasoning [off\|low\|high\|max]` | 设置推理强度 |
| `/stop` | 中止当前轮次 |
| `/approve` `/deny` `/approvals` | 处理工具审批 |
| `/help` | 列出所有可用命令 |

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
飞书用户 → Lark SDK (WebSocket) → dsh-feishu → Harness Agent → 回复卡片
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
