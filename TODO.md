# dsh-feishu TODO

> 定位见 [AGENTS.md](./AGENTS.md)：**把 DSH 的原生特性接入飞书，而非再造一个 agent 平台/助手**。
> 状态：`已有` ✅ / `部分` ⚠️ / `待实现` 🔲 / `规划中` 📋 / `待调研` 🔍

---

## 已完成

| # | 功能 | 说明 |
|---|---|---|
| 1 | 卡片化 + footer | 最终回复卡片底部标注 workspace + preset + **模型名** + **思考强度** + **上下文使用量** |
| 4 | `/status` 命令 | 展示 session id / title / workspace / preset / model / **reasoning** / tokens / context / **缓存命中率** / **TTFT** / **吞吐量** / **LLM 时间** / **工具时间** |
| 5 | 工具调用展示 | 订阅 `apiProxy.events.mux` → `tool/call` + `tool/result`，wathet/green/red 卡片。**原地更新**：`tool/call` 发卡片后保存 `messageId`，`tool/result` 用 `updateCard` 更新同一张卡片 |
| 6 | todo 展示 | 订阅 `apiProxy.events.mux` → `todo/write`，turquoise 卡片含进度条 |
| 11 | 中间消息不可见 | ✅ 改为 `apiProxy.events.mux` + `tool/call` 时 flush 累积文字，紫色卡片 |
| 12 | tool call 卡片 markdown 渲染 | ✅ `lark_md` → `markdown`，4 文件 11 处 |
| 13 | 卡片 Markdown 渲染不稳定 | ✅ 全面迁移到 Card JSON 2.0，表格/标题/内联代码原生渲染，移除降级逻辑 |
| 14 | 纯查询命令即时返回 | ✅ fire-and-forget + agent 运行状态检测 |
| 15 | Agent 消息队列调研 | 两层队列机制已确认（见下方调研记录） |
| 17 | `/reasoning` 思考强度命令 | ✅ `/reasoning [off|low|high|max]`，通过 `agentDefaultModel.saveSelection` 持久化 |
| 19 | tool_call / tool_done 顺序问题 | ✅ `tool/call` 直接发送保存 `messageIdPromise`，`tool/result` 等待后 `updateCard`，消除竞态 |
| 20 | 工具调用摘要 | ✅ 通过 mux `frame.view` 获取 `presentCall`/`presentResult` 的 `description`、`title`，显示在工具名称上方 |
| 21 | 卡片颜色区分 | ✅ 工具调用中 wathet → 成功 green → 失败 red；Reply 蓝色；Turn Complete 绿色 |
| 22 | Reply 标题命名 | ✅ 已统一为 "Reply" |
| — | `/stop` 命令 | 通过 `apiProxy.sessions.cancel` 中断运行中的 agent，等同 WebUI 停止按钮 |
| — | `/stream` 命令 | 切换 `showIntermediateMessages` 设置（已与中间消息模块解耦，保留备用） |
| — | 统一 per-step 卡片 | ✅ 每个 step 一张卡片，包含 reasoning + text + 工具调用 + 结果预览 + step 时长/token footer |
| — | 工具结果预览 | ✅ 按 `resultView.card` 类型分发渲染（terminal/web/search/read/diff/generic） |
| — | 工具名称内联代码 | ✅ 工具名用 `` ` `` 内联代码展示（如 `` `read` ``、`` `edit` ``） |
| — | Turn Complete 卡片 | ✅ 显示轮次时长、TTFT、吞吐量、输入输出 token、缓存命中率 |
| — | Step token footer | ✅ 每个 step 卡片底部显示时长 + 输入输出 token |
| — | Debounce + flush 同步 | ✅ 150ms debounce 合并快速更新，turn/end 时 flush 确保 footer 在 card update 之后发送 |
| — | 防止卡片消失 | ✅ 内层 try/catch 保护 mux 事件处理，timer 回调 error-safe |

## 待实现

| # | 功能 | 优先级 | 说明 |
|---|---|---|---|
| 16 | 权限系统接入 | **中** | 新增 `/permission` `/sandbox`，对齐 WebUI 权限设定 |
| 18 | 思考内容可折叠 | **中** | reasoning 代码块支持折叠（飞书 Card JSON 2.0 `collapsible` 组件） |
| 2 | `/new` 带参数 | **中** | `/new --workspace <path> --preset <id>` |
| 3 | 工作区候选补全 | **中** | 输入前缀列出匹配目录供选 |
| 9 | 流式输出 → CardKit | **低** | 解决 5 QPS 瓶颈，需调研 CardKit API |
| 7 | 多 thread 话题导航 | **低** | 飞书话题映射 DSH session，底层已通 |
| 8 | 文档与版本一致性 | **低** | README 过期、版本号不一致 |

---

## 卡片颜色参考

| 颜色 | 用途 | 文件 |
|---|---|---|
| blue | Reply 回复卡片、问题卡片 | `channel.ts`、`feishu-questions.ts` |
| turquoise (青绿) | Todo 列表卡片 | `feishu-todos.ts` |
| wathet (浅蓝) | Tool Call 调用中 | `feishu-streaming.ts` |
| green | Tool Result 成功 / Turn Complete | `feishu-streaming.ts`、`channel.ts` |
| red | Tool Error 失败 | `feishu-streaming.ts` |
| orange | 审批请求 | `feishu-approvals.ts` |
| grey | 无选项问题 | `feishu-questions.ts` |

---

## #11 中间消息不可见 —— ✅ 已修复

- **根因 1**：旧代码用 `ctx.on('session/event')` 订阅 Cordis 事件，在插件 scope 中不生效
- **根因 2**：旧代码依赖 `showIntermediateMessages` 设置，默认为 `false`
- **修复**（2025-08-25）：
  - 改用 `apiProxy.events.mux()` SSE（与 toolcalls/todos 一致）
  - 逻辑：`assistant/chunk` → 累积 text-delta → `tool/call` 到达时 flush 为紫色卡片
  - 不再依赖 `/stream` 开关或 `showIntermediateMessages` 设置
  - 不再调用 `markIntermediateSent`（中间消息 ≠ 最终回复，不应跳过最终卡片）

## #17 `/reasoning` 思考强度命令 —— ✅ 已实现

- **命令**：`/reasoning` 查看 / `/reasoning off|low|high|max` 设置
- **持久化**：通过 `agentDefaultModel.saveSelection()` 写入 DSH settings，重启后自动恢复
- **联动**：status 卡片 + footer 均显示当前 reasoning effort

## #12 tool call 卡片 markdown 不渲染 —— ✅ 已修复

- **问题**：`feishu-toolcalls.ts` / `feishu-todos.ts` / `feishu-questions.ts` / `feishu-approvals.ts` 使用 `{ tag: 'div', text: { tag: 'lark_md' } }`，只支持粗体/斜体/链接，不支持代码块。
- **修复**：改为 `{ tag: 'markdown', content }`（同 reply card）。`channel.ts` 的 note 区保持 `lark_md`（note 只支持 lark_md）。

## #13 卡片 Markdown 渲染不稳定 —— ✅ 已修复（Card JSON 2.0）

- **根因**：Card JSON 1.0 的 markdown 组件不支持表格、标题、内联代码等完整语法
- **修复**（2025-08-25）：
  - 全面迁移到 **Card JSON 2.0**（`schema: '2.0'` + `body.elements`）
  - 表格、标题、内联代码（反引号）原生渲染，不再降级
  - `note` 标签（2.0 不支持）替换为 `markdown` + `text_size: 'notation'`
  - 删除 `needsPlainTextFallback()`、`logReplyDiagnostic()`、`buildFooterText()` 三个废弃函数
  - 回复流程简化：始终发卡片，不再有 markdown 消息降级路径

## #16 权限系统接入

- **DSH 权限**：3 种 sandbox 模式（read-only / workspace-write / danger-full-access）+ permission presets
- **Session 事件**：`sandbox/mode`、`permission/preset`，持久化在 session log
- **飞书接入**：`/permission` 列出 presets + 切换；`/sandbox` 直接切模式
- **待调研**：`permissionPresets` service API、`setSandboxMode` API、与 WebUI `/permission` 命令是否冲突

## #18 思考内容展示

- **目标**：模型 reasoning/thinking 内容以卡片形式展示，内容放在代码块里防止占用过多行
- **数据源**：`assistant/chunk` 事件中 `chunk.type === 'reasoning-delta'` 的文本
- **UI 方案**：紫色卡片（同中间消息），reasoning 文字包裹在 ` ``` ` 代码块中，可折叠

## #18 思考内容展示 —— 部分完成

- **已完成**：
  - `feishu-streaming.ts` 累积 `reasoning-delta` chunks
  - 在 `assistant/message` 时发送 step 卡片，reasoning 放在代码块中
  - `/reasoning show on|off` 控制是否显示 reasoning 内容
- **待优化**：
  - reasoning 代码块可折叠（飞书 Card JSON 2.0 支持 `collapsible` 组件）
  - reasoning 长度截断策略（当前 3000 字符）

## #19 tool_call / tool_done 顺序问题 —— ✅ 已修复

- **现象**：有时飞书先收到 tool result（绿色/红色卡片），后收到 tool call（蓝色卡片），顺序反了
- **根因**：`tool/call` 和 `tool/result` 都走 `scheduleBatch`（200ms debounce），`tool/result` 到达时 `messageId` 可能还没保存（异步竞态）
- **修复**（2025-08-25）：
  - `tool/call` 卡片**直接发送**（不走批量队列），保存 `messageIdPromise`
  - `tool/result` 时 `await messageIdPromise` 确保拿到 `messageId` 后再 `updateCard`
  - 效果：一张卡片从蓝色（调用中）→ 绿色/红色（完成），不再出现两张卡片

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
