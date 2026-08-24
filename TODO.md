# dsh-feishu TODO

> 定位见 [AGENTS.md](./AGENTS.md)：**把 DSH 的原生特性接入飞书，而非再造一个 agent 平台/助手**。
> 状态：`已有` ✅ / `部分` ⚠️ / `待实现` 🔲 / `规划中` 📋 / `待调研` 🔍

---

## 已完成

| # | 功能 | 说明 |
|---|---|---|
| 1 | 卡片化 + footer | 最终回复渲染为飞书卡片，底部标注 workspace + preset |
| 4 | `/status` 命令 | 展示 session id / title / workspace / preset / model / tokens / context |
| 5 | 工具调用展示 | 订阅 `tool/call` + `tool/result`，蓝色/绿色/红色卡片 |
| 6 | todo 展示 | 订阅 `todo/write`，绿色卡片含进度条 |
| 15 | Agent 消息队列调研 | 两层队列机制已确认（见下方调研记录） |

## 待实现

| # | 功能 | 优先级 | 说明 |
|---|---|---|---|
| 12 | tool call 卡片 markdown 渲染 | **高** | `lark_md` → `markdown`，11 处改动，立即改善可读性 |
| 13 | 卡片 Markdown 渲染不稳定 | **高** | 标题不稳定、表格不渲染（普通消息正常），需降级方案 |
| 11 | 非流式中间消息不可见 | **高** | `/stream` 开启后仍不可见，需诊断 enabled() + 事件流 |
| 14 | 纯查询命令即时返回 | **中** | Agent 忙时 `/status` 排队等待，需分离命令处理 |
| 16 | 权限系统接入 | **中** | 新增 `/permission` `/sandbox`，对齐 WebUI 权限设定 |
| 2 | `/new` 带参数 | **中** | `/new --workspace <path> --preset <id>` |
| 3 | 工作区候选补全 | **中** | 输入前缀列出匹配目录供选 |
| 9 | 流式输出 → CardKit | **低** | 解决 5 QPS 瓶颈，需调研 CardKit API |
| 7 | 多 thread 话题导航 | **低** | 飞书话题映射 DSH session，底层已通 |
| 8 | 文档与版本一致性 | **低** | README 过期、版本号不一致 |

---

## #12 tool call 卡片 markdown 不渲染

- **问题**：`feishu-toolcalls.ts` / `feishu-todos.ts` / `feishu-questions.ts` / `feishu-approvals.ts` 使用 `{ tag: 'div', text: { tag: 'lark_md' } }`，只支持粗体/斜体/链接，不支持代码块。
- **修复**：改为 `{ tag: 'markdown', content }`（同 reply card）。`channel.ts:305` 的 note 区保持 `lark_md`（note 只支持 lark_md）。
- **验收**：tool call 卡片代码块正确渲染。

## #13 卡片 Markdown 渲染不稳定

- **实测**：列表 ✅ 稳定 | 标题 ❌ 不稳定 | 表格 ❌ 几乎不渲染
- **对比**：飞书普通消息的表格完全正常——是卡片 markdown 组件的限制
- **缓解方案**：表格用 `div` + `column_set` 模拟；标题用粗体模拟；或降级为普通消息

## #11 非流式中间消息不可见

- **现状**：`feishu-streaming.ts` 订阅 `assistant/message`，`/stream` 开关默认 OFF
- **待查**：`enabled()` 回调是否生效？settings 是否持久化？agent 多步循环是否发出事件？
- **已加诊断日志**：listener 启动 + 前 3 个 assistant/message 事件会打 log

## #14 纯查询命令即时返回

- **问题**：`/status` `/help` `/approvals` 不需要 LLM，但飞书 `chatQueue` 按 chat 串行化，需等前一条消息处理完
- **方案**：channel handler 中分离「需要 agent」和「不需要 agent」命令，后者立即处理

## #16 权限系统接入

- **DSH 权限**：3 种 sandbox 模式（read-only / workspace-write / danger-full-access）+ permission presets
- **Session 事件**：`sandbox/mode`、`permission/preset`，持久化在 session log
- **飞书接入**：`/permission` 列出 presets + 切换；`/sandbox` 直接切模式
- **待调研**：`permissionPresets` service API、`setSandboxMode` API、与 WebUI `/permission` 命令是否冲突

## #9 流式输出技术方案

> 详见下方 [飞书流式输出技术方案](#飞书流式输出技术方案)。

- **现状**：每次发独立新卡片，5 QPS 限制
- **目标**：CardKit 流式更新（单卡持续更新，无 QPS 限制）
- **状态**：方案已设计，待实现

---

## 飞书流式输出技术方案

### 现状：普通卡片发送（5 QPS 限制）

```
POST /im/v1/messages → 每张独立消息，5 QPS
```

### 目标：CardKit 流式更新（无 QPS 限制）

```
POST /cardkit/v1/card {streaming_mode: true} → 创建流式卡片，拿到 card_id
POST /cardkit/v1/card/:card_id/contents      → 持续更新，无 QPS 限制
```

| 限制项 | 值 |
|---|---|
| 流式更新 QPS | **无限制** |
| 卡片大小 | 30KB |
| 组件数量 | 200 个 |
| 自动关闭 | 10 分钟 |
| 文本流式频率 | 70ms/次（可配） |

### 参考

- [流式更新卡片概述](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview.md)
- [飞书AI机器人流式输出实践](https://juejin.cn/post/7600990891206819867)
- [CardKit 流式更新 Python 示例](https://feishu.danling.org/streaming/cardkit/)

---

## Agent 消息队列调研记录

- **两层队列**：Lark SDK `chatQueue`（per-chat 串行）+ DSH Agent `Inbox`（per-agent 应用层）
- **`followup()`**：消息进 `next-turn` 队列，`wakeRequested` latch，当前 turn 完成后自动处理
- **`whenIdle()`**：spin-until-stable，等所有排队 turn 完成才返回
- **关键结论**：消息不会丢失，但飞书侧需等当前 turn 完成才能响应
