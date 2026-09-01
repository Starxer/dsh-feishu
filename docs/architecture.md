# Architecture

```text
飞书用户
  │ im.message.receive_v1 (WebSocket)
  ▼
Lark SDK (自动重连、去重、串行处理)
  │ NormalizedMessage
  ▼
dsh-feishu 会话适配器
  │ chat/thread → SessionId
  ▼
Workspace + Agent Preset 组合
  │ cwd + tools + system prompt
  ▼
Harness Agent (模型、工具、会话日志)
  │ assistant text + tool results
  ▼
飞书卡片 (per-step card + Turn Complete)
```

## 核心模块

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口，注册服务和命令 |
| `src/channel.ts` | 飞书 Channel 封装，入站图片/文件接收（`admitImagesForMessage`/`admitFilesForMessage`），回复卡片渲染，Turn Complete 卡片 |
| `src/harness.ts` | Harness 会话服务，session 映射持久化 |
| `src/feishu-streaming.ts` | 统一 per-step 卡片：订阅 mux 事件流，渲染 reasoning + text + 工具调用 + 结果预览 + 时长/token footer |
| `src/feishu-todos.ts` | Todo 进度卡片 |
| `src/feishu-approvals.ts` | 工具审批处理 |
| `src/feishu-questions.ts` | ask_user_question 卡片 |
| `src/commands.ts` | 斜杠命令注册和处理 |

## 事件流

每个 agent step 的事件流：

```
step/start       → 记录开始时间
assistant/chunk  → 累积 reasoning/text，记录首 token 时间
assistant/message → 发送 step 卡片，记录 usage
tool/call        → 追加工具调用信息，更新卡片
tool/result      → 追加工具结果和预览，更新卡片，记录完成时间
turn/end         → flush debounce，发送 Turn Complete 卡片
```

## 卡片设计

- **Step 卡片**：每个 agent step 一张，wathet→green/red 颜色变化，底部显示时长和 token
- **Turn Complete 卡片**：turn 结束后发送，绿色，展示性能指标和配置信息
- **Todo 卡片**：turquoise，含进度条
- **审批卡片**：orange，含 approve/deny 按钮

## 技术要点

- **Debounce**：150ms 合并快速更新，减少 API 调用
- **Flush 同步**：`turn/end` 时 flush pending debounce，确保卡片更新在 Turn Complete 之前完成
- **Error-safe**：内层 try/catch 保护 mux 事件处理，防止单个事件错误导致整个流断开
- **Card JSON 2.0**：所有卡片使用 `schema: '2.0'` + `body.elements`，原生支持 markdown
- **入站图片判型按字节**：飞书 `messageResource` 不给内容 MIME、SDK 归一化的 image 资源无文件名，故图片必须**先下载字节、用 magic bytes 判真实格式**（`sniffImageMime`）再交给 `attachments.saveImage`，**不得猜 JPEG**——DSH 附件库会校验声明与实际字节（`IMAGE_TYPE_MISMATCH`），猜错即拒收非 JPEG 图片
- **入站文件落工作区收件箱**：文件经 `admitFilesForMessage` 落到会话工作区根 `.feishu-inbox/`（`resolveWorkspaceRoot` 解析，无则回退全局）；图片走 DSH 原生附件库（`~/.dsh/attachments/v1/`），**两条独立路径**
