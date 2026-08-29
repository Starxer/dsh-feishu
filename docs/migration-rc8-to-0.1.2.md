# 迁移分析：DSH rc.8 → 0.1.2-alpha.1

> 基于 commit `cd5ef81481`（0.1.2-alpha.1）分析，距当前运行版本 rc.8 有 **1286 个 commit**。
> 创建日期：2026-08-29

## 一、核心破坏性变更：`@deepseek-ai/dsh-host-apiproxy` 被完全删除

commit `4f00a8b82a` "refactor(api): remove ApiProxy package" — 整个 `packages/host/apiproxy/` 目录被删除（**-3529 行**）。

这是飞书插件最关键的依赖——**所有事件流、审批、问答、模型选择、会话取消都通过 `apiProxy` 实现**。

### 删除的内容

- `packages/host/apiproxy/src/api-proxy.ts` — Host-side ApiProxy 实现
- `packages/host/apiproxy/src/api/` — 所有 API 域接口（events, sessions, approvals, questions, rpc 等）
- `packages/host/apiproxy/src/fetch/` — Client/Handler transport 层
- `packages/host/apiproxy/src/session-export.ts` — Session 导出
- `packages/host/apiproxy/tests/` — 所有测试
- `packages/host/apiproxy/package.json` — 包定义

### 新架构：Typert Remote 拆分

旧的 `apiProxy` 是一个**统一 gateway 服务**，新架构将其拆分为多个独立的 Remote 服务：

| 旧 ApiProxy 域 | 新 Remote 服务 | 包 |
|---|---|---|
| `apiProxy.sessions.*` | `sessionController.*` | `@deepseek-ai/dsh-api-session-controller` |
| `apiProxy.settings.*` | `settingsController.*` | `@deepseek-ai/dsh-api-settings-controller` |
| `apiProxy.workspace.*` | `workspaceController.*` | `@deepseek-ai/dsh-api-workspace-controller` |
| `apiProxy.credentials.*` | `credentialsController.*` | — |
| `apiProxy.events.mux/host` | `sessionController.control()` + `sessionController.follow()` | `@deepseek-ai/dsh-api-session-controller` |
| `apiProxy.respond()` | Cordis 内置 answerer/provider 注册 | `approval` / `userQuestions` |
| `apiProxy.llm.*` | `llm.*` | `@deepseek-ai/dsh-llm` |

Transport 层由新的 `connection` 服务（`@deepseek-ai/dsh-client-connection`）接管。

### web-app cordis.patch.yml 变化

```diff
- id: api-gateway
-   name: '@deepseek-ai/dsh-host-apiproxy'

+ id: session-controller
+   name: '@deepseek-ai/dsh-api-session-controller'
+ id: settings-controller
+   name: '@deepseek-ai/dsh-api-settings-controller'
+ id: workspace-controller
+   name: '@deepseek-ai/dsh-api-workspace-controller'
+ id: connection
+   name: '@deepseek-ai/dsh-client-connection'
+ id: api-remotes
+   name: '@deepseek-ai/dsh-api-remotes'
```

### 迁移文档参考

DSH 官方迁移文档：
`.agents/notes/implemented/architecture/2026-08-10-unary-apiproxy-remote-migration.md`

---

## 二、飞书插件受影响文件清单

### 直接引用 `@deepseek-ai/dsh-host-apiproxy` 的文件

| 文件 | 使用的 API | 影响程度 |
|---|---|---|
| `src/index.ts` | `ApiProxy` 类型, `RpcId`, `inject: ['apiProxy']`, `ctx.get('apiProxy')`, `apiProxy.events.mux()`, `apiProxy.sessions.cancel()` | 🔴 严重 |
| `src/feishu-streaming.ts` | `ApiProxy`, `MuxFrame`, `RpcId`, `apiProxy.events.mux()` | 🔴 严重（核心事件流） |
| `src/feishu-approvals.ts` | `ApiProxy`, `MuxFrame`, `RpcId`, `apiProxy.events.mux()`, `apiProxy.respond()` | 🔴 严重 |
| `src/feishu-questions.ts` | `ApiProxy`, `MuxFrame`, `RpcId`, `QuestionResponsePayload`, `apiProxy.events.mux()`, `apiProxy.respond()` | 🔴 严重 |
| `src/feishu-todos.ts` | `ApiProxy`, `MuxFrame`, `RpcId`, `apiProxy.events.mux()` | 🟡 中等 |
| `src/feishu-toolcalls.ts` | `ApiProxy`, `MuxFrame`, `RpcId`, `apiProxy.events.mux()` | 🟡 中等 |
| `src/feishu-model-select.ts` | `ApiProxy`, `apiProxy.sessions.selectModel()` | 🟡 中等 |
| `src/commands.ts` | `ApiProxy`, `apiProxy.sessions.selectModel()` | 🟡 中等 |

### 间接影响的文件

| 文件 | 影响 |
|---|---|
| `src/harness.ts` | 不直接引用 apiproxy，但依赖 session 事件流 |
| `src/channel.ts` | 不直接引用 apiproxy |
| `src/config.ts` | 不受影响 |
| `src/conversation.ts` | 不受影响 |

### `package.json` 影响

```json
// peerDependencies 需要移除
"@deepseek-ai/dsh-host-apiproxy": "^0.1.0-rc.5"

// devDependencies 需要移除
"@deepseek-ai/dsh-host-apiproxy": "^0.1.0-rc.7"

// peerDependencies 需要新增
"@deepseek-ai/dsh-api-session-controller": "^0.1.2-alpha.1"
```

---

## 三、逐 API 迁移映射

### 3.1 `apiProxy.events.mux()` → 多源订阅

**旧架构**：`apiProxy.events.mux()` 是一个 all-session 聚合的 multiplexed 流，推送所有类型的帧：

```typescript
// 旧：一个流包含所有事件类型
for await (const envelope of apiProxy.events.mux(
  { rpcId: RpcId(`feishu-streaming-${Date.now()}`), payload: {} },
  controller.signal,
)) {
  const frame = envelope.payload as MuxFrame
  // frame.type 可能是：
  //   'session/event'        → session 事件（chunk, tool/call, tool/result 等）
  //   'session/subscribed'   → session 订阅确认
  //   'session/queue'        → 待处理队列
  //   'approval/requested'   → 审批请求
  //   'approval/resolved'    → 审批结果
  //   'question/requested'   → 问答请求
  //   'question/resolved'    → 问答结果
}
```

**新架构**：需要拆分为多个独立的订阅源：

```typescript
// 方案 A：Host-side 直接订阅 Cordis 事件（推荐，因为飞书插件运行在 DSH 进程内）

// 1. Session 事件流
ctx.on('session/event', (session, event) => {
  // event.type: 'assistant/chunk', 'tool/call', 'tool/result', 'turn/start', 'turn/end', etc.
  // session.id → sessionId
})

// 2. 控制帧（queue, jobs, projections）
// sessionController.control() 返回 AsyncIterable<SessionControlFrame>
// 但这是 Remote API，Host-side 插件可能需要直接使用 ctx.on()

// 3. 审批请求 → 注册 approval answerer
ctx.on('approval/request', (req, next) => {
  // 推送卡片到飞书
  // 等待用户响应
  // return outcome
})

// 4. 问答请求 → 注册 userQuestions provider
// 通过 userQuestions.ask() 内置的 provider 机制
```

**新的帧类型**：

```typescript
// SessionControlFrame（替代部分 MuxFrame）
type SessionControlFrame =
  | { type: 'baseline'; value: SessionControlBaseline }
  | { type: 'queue'; sessionId: SessionId; items: readonly SessionQueuedItem[] }
  | { type: 'jobs'; sessionId: SessionId; jobs: readonly SessionJob[] }
  | { type: 'projection'; sessionId: SessionId; key: string; value: JsonValue; seq: number }

// SessionFollowFrame（替代 session/event 帧）
type SessionFollowFrame =
  | { type: 'snapshot'; header: SessionHeader; cursor: number; records: readonly SessionHistoryRecord[]; hasMore: boolean; projections: SessionProjectionBaseline }
  | SessionEventEntry  // { type: 'event'; event: SessionEvent }
```

### 3.2 `apiProxy.sessions.selectModel()` → `sessionController.selectModel()`

**旧**：
```typescript
await apiProxy.sessions.selectModel({
  rpcId: RpcId(`feishu-model-select-${Date.now()}`),
  payload: { sessionId, provider, model, reasoningEffort },
})
```

**新**：
```typescript
// 通过 sessionController（Host-side）
await sessionController.selectModel({
  sessionId,
  provider,
  model,
  ...reasoningEffort === undefined ? {} : { reasoningEffort },
})
```

### 3.3 `apiProxy.sessions.cancel()` → `sessionController.cancel()`

**旧**：
```typescript
const response = await apiProxy.sessions.cancel({
  rpcId: RpcId(`feishu-stop-${Date.now()}`),
  payload: { sessionId },
})
```

**新**：
```typescript
sessionController.cancel({ sessionId })
// 返回 { accepted: true }
```

### 3.4 `apiProxy.respond()` (审批) → approval answerer 注册

**旧**：
```typescript
// 审批响应通过 RPC respond
const receipt = await apiProxy.respond({
  rpcId: pending.rpcId,
  payload: { outcome } as ApprovalResponsePayload,
})
```

**新**：不再有 respond 机制。审批通过 Cordis `ctx.on('approval/request', ...)` 直接在 answerer 中返回 outcome。

```typescript
ctx.on('approval/request', (req, next) => {
  // 推送审批卡片到飞书
  // 等待用户点击
  // return 'allowed-once' | 'denied' | 'cancelled'
})
```

### 3.5 `apiProxy.respond()` (问答) → userQuestions provider

**旧**：
```typescript
const receipt = await apiProxy.respond({
  rpcId: pending.questionRpcId,
  payload: { answers } as QuestionResponsePayload,
})
```

**新**：问答通过 `userQuestions.ask()` 的内置 provider 机制。飞书插件需要注册为 answerer。

### 3.6 `RpcId` → 自行生成

**旧**：从 `@deepseek-ai/dsh-host-apiproxy` 导入 `RpcId`

**新**：RPC 机制不再暴露给插件。飞书插件内部的 ID 生成可以使用 `crypto.randomUUID()` 或自定义 branded type。

---

## 四、`inject` 列表变更

**旧**：
```typescript
export const inject = [
  'agents', 'sessions', 'sessionPersistence', 'agentDefaultModel',
  'agentPresets', 'workspaceRegistry', 'settings', 'credentials',
  'webServer', 'commands', 'llm', 'attachments', 'apiProxy',
]
```

**新（候选）**：
```typescript
export const inject = [
  'agents', 'sessions', 'sessionPersistence', 'agentDefaultModel',
  'agentPresets', 'workspaceRegistry', 'settings', 'credentials',
  'webServer', 'commands', 'llm', 'attachments',
  // 'apiProxy' 已删除，替换为：
  'sessionController',  // 新：session 操作（selectModel, cancel, control, follow）
  // 注意：approval 和 userQuestions 可能不需要在 inject 中声明，
  //       因为它们是可选的 answerer 注册而非必须服务
]
```

**⚠️ 注意**：`sessionController` 是 web-app bundle 中的服务（`@deepseek-ai/dsh-api-session-controller`），在纯 CLI 模式下可能不存在。飞书插件需要优雅处理其缺失。

---

## 五、其他次要变更

### 5.1 `code-mode` 重命名为 `ptc` (PTC mode)

commit `3ca9c7d489` "rename code-mode to ptc (PTC mode)"

如果飞书插件引用了 code-mode 相关类型/配置，需要更新。

### 5.2 新增必需服务

| 服务 | 用途 | 影响 |
|---|---|---|
| `storage` / `storage-json` / `storage-domain` | 持久化 KV 存储 | base bundle 新增，插件无需直接使用 |
| `session-projection-cache` | Session 投影缓存 | base bundle 新增 |
| `deepseek-llm-api-extensions` | DeepSeek API 扩展 | base bundle 新增 |
| `session-log-deepseek` | Session 日志 DeepSeek 格式 | base bundle 新增 |
| `plugin-package-inventory-deepseek` | 插件包清单 | base bundle 新增 |

### 5.3 telemetry 默认值变化

`session-telemetry-otel` 默认从 `DISABLED` 变为 `FEEDBACK_ONLY`。不影响功能但需注意。

### 5.4 web-app 新增客户端服务

| 服务 | 用途 |
|---|---|
| `@deepseek-ai/dsh-client-connection` | Web transport 层（替代旧 apiproxy 的 fetch/SSE） |
| `@deepseek-ai/dsh-api-remotes` | 生成的 Remote 客户端 |
| `@deepseek-ai/dsh-cordis-host-runner` / `cordis-client-runner` | Host/Client runner |

### 5.5 `dsh.client` inject 列表

飞书插件的 `package.json` 中 `dsh.client.inject` 需要检查是否仍兼容：

```json
"inject": [
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-settings"
]
```

`@deepseek-ai/dsh-client-runtime` 在新版本中从独立包变为 web-app 内置（`client-runtime` 行在 web-app cordis.patch.yml 中），需要确认是否仍可从外部引用。

---

## 六、风险评估

| 风险 | 级别 | 说明 |
|---|---|---|
| 事件流全面重构 | 🔴 高 | `mux()` 是单一流聚合所有帧类型，新架构拆分为多个独立源。飞书插件的 streaming/approvals/questions/todos/toolcalls 五个模块全部依赖 mux 流。 |
| 审批/问答 respond 机制消失 | 🔴 高 | 旧架构通过 HTTP respond 回答 server-request，新架构通过 Cordis answerer 注册。需要理解新的 provider/answerer 生命周期。 |
| sessionController 可用性 | 🟡 中 | `sessionController` 是 web-app bundle 的服务，飞书插件在 host-plane 可能无法直接注入。需要验证。 |
| MuxFrame 类型消失 | 🟡 中 | 需要用 `SessionControlFrame` + `SessionFollowFrame` + 自定义事件类型替代。 |
| RpcId 消失 | 🟢 低 | 简单替换为 `crypto.randomUUID()` 或自定义 ID。 |

---

## 七、建议迁移策略

### Phase 1：编译通过 + 启动不报错

1. 移除 `@deepseek-ai/dsh-host-apiproxy` 依赖
2. 替换 `inject` 列表中的 `'apiProxy'`
3. 用临时 stub 替换所有 `apiProxy.*` 调用（让插件能编译并启动）
4. 事件流/审批/问答等功能暂时禁用或降级

### Phase 2：核心功能恢复

1. 实现 session 事件订阅（替代 `mux()` 中的 `session/event` 帧）
2. 恢复 `/model` 和 `/stop` 命令（`selectModel` + `cancel`）
3. 恢复 streaming 卡片（per-step 卡片、turn-complete 卡片）

### Phase 3：交互功能恢复

1. 实现审批 answerer（替代 `respond()` 审批路径）
2. 实现问答 provider（替代 `respond()` 问答路径）
3. 恢复 todo 和 toolcalls 订阅

---

## 八、参考

- DSH 源码：`本机 deepseek-harness 工作区/`
- 目标 commit：`cd5ef81481`（0.1.2-alpha.1）
- 迁移文档：`.agents/notes/implemented/architecture/2026-08-10-unary-apiproxy-remote-migration.md`
- 新 session-controller API：`packages/api/session-controller/src/`
- 新 API catalog：`packages/extensions/tool-cordis/src/api-catalog.ts`
- 新 web-app bundle：`packages/bundle/web-app/cordis.patch.yml`
- 新 base bundle：`packages/bundle/base/cordis.patch.yml`
