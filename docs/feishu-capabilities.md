# 飞书能力调研

> 本文件记录飞书开放平台支持的消息类型、卡片组件、权限、事件订阅等能力，
> 供 dsh-feishu 功能规划参考。
>
> 更新时间：2025-08-27

---

## 一、消息类型

飞书 `im.v1.message.create` 支持的 `msg_type`：

| 类型 | msg_type | 说明 | dsh-feishu 现状 | 潜在场景 |
|---|---|---|---|---|
| 纯文本 | `text` | 无格式文本 | ✅ 斜杠命令回复 | — |
| 富文本 | `post` | 加粗/链接/@/图片混排 | SDK 支持，未使用 | 格式化回复（替代纯 markdown） |
| 图片 | `image` | 上传图片消息 | 未使用 | 输出图片/截图/图表 |
| 文件 | `file` | 文件附件 | 未使用 | 导出代码/文档/PDF |
| 音频 | `audio` | 语音消息 | 未使用 | — |
| 视频 | `video` | 视频消息 | 未使用 | — |
| 表情贴纸 | `sticker` | 贴纸表情 | 未使用 | 趣味回复 |
| **卡片** | `interactive` | 交互式卡片（按钮/选择器/表单） | ✅ 主要使用 | 核心 UI |
| 分享群聊 | `share_chat` | 分享群聊卡片 | 未使用 | 快速分享群给用户 |
| 分享用户 | `share_user` | 分享联系人卡片 | 未使用 | — |

**SDK 调用方式**（`channel.send`）：

```js
channel.send(chatId, { text: 'hello' })           // 纯文本
channel.send(chatId, { card: { schema: '2.0', ... } }) // 卡片
channel.send(chatId, { markdown: '**bold**' })     // 富文本（SDK 自动转 post）
channel.send(chatId, { image: { key: 'xxx' } })    // 图片
channel.send(chatId, { file: { key: 'xxx' } })     // 文件
channel.send(chatId, { shareChat: { chatId } })    // 分享群聊
```

---

## 二、Card JSON 2.0 组件

飞书卡片 JSON 2.0（`schema: '2.0'`）支持的组件分为三类：

### 2.1 内容组件（Content）

| 组件 | tag | 说明 | dsh-feishu 现状 |
|---|---|---|---|
| 普通文本 | `plain_text` | 无格式文本 | ✅ 卡片 header |
| Markdown | `markdown` | 表格/标题/内联代码/链接/粗体/斜体 | ✅ 主要使用 |
| Lark Markdown | `lark_md` | 旧版 markdown（仅粗体/斜体/链接） | ⚠️ note 区域使用 |
| 图片 | `img` | 图片组件 | 未使用 |
| 表格 | `table` | 结构化表格 | 未使用 |
| 图表 | `chart` | 柱状图/折线图/饼图等 | 未使用 |
| 多列布局 | `column_set` + `column` | 多列并排 | 未使用 |

### 2.2 交互组件（Interactive）

| 组件 | tag | 说明 | dsh-feishu 现状 | 潜在场景 |
|---|---|---|---|---|
| **按钮** | `button` | 点击按钮，触发 `cardAction` | ✅ 审批卡片 | 通用操作 |
| **单选下拉** | `select_static` | 下拉单选，选项列表 | ❌ 未使用 | `/model` 选模型、选 workspace、选 preset |
| **多选下拉** | `multi_select_static` | 下拉多选 | ❌ 未使用 | 批量操作选项 |
| **日期选择** | `date_picker` | 日期选择器 | ❌ 未使用 | — |
| **时间选择** | `time_picker` | 时间选择器 | ❌ 未使用 | — |
| **人员选择** | `select_person` | 选择人员 | ❌ 未使用 | 多人协作 |
| **文本输入** | `input` | 文本输入框 | ❌ 未使用 | 带占位符的输入（替代部分斜杠命令） |
| **溢出菜单** | `overflow` | 更多操作菜单 | ❌ 未使用 | 查看上下文/清空/导出 |

### 2.3 容器/布局组件（Container）

| 组件 | tag | 说明 | dsh-feishu 现状 | 潜在场景 |
|---|---|---|---|---|
| **可折叠** | `collapsible` | 折叠/展开内容块 | ❌ 未使用 | 🔥 长 reasoning、长工具输出 |
| **标签页** | `tab` + `tab_content` | 多标签页切换 | ❌ 未使用 | 多 step 结果分页查看 |
| 分割线 | `hr` | 水平分割线 | ✅ 已使用 | — |
| 注释 | `note` | 底部注释（Card JSON 1.0） | ⚠️ 2.0 不支持 | 用 `markdown` + `text_size: 'notation'` 替代 |

### 2.4 交互回调

所有交互组件的用户操作通过 `card.action.trigger` 事件回调：

- **WebSocket 长连接模式**：自动推送，**不需要额外事件订阅或权限**
- **回调数据**：`evt.action.value`（JSON 字符串）、`evt.action.tag`（组件类型）、`evt.chatId`、`evt.messageId`
- **SDK 处理**：`LarkChannel.on('cardAction', handler)` 监听

```js
// 按钮点击回调
channel.on('cardAction', (evt) => {
  const value = JSON.parse(evt.action.value) // { rpcId: '...', outcome: '...' }
  // 处理逻辑...
})

// 选择器回调
channel.on('cardAction', (evt) => {
  if (evt.action.tag === 'select_static') {
    const selected = evt.action.option // 选中的 value
  }
})
```

---

## 三、权限（Scopes）

### 3.1 当前已配置

| 权限 | 说明 | 用途 |
|---|---|---|
| `im:message.p2p_msg:readonly` | 读取私聊消息 | 接收用户消息 |
| `im:message.group_at_msg:readonly` | 读取群聊 @消息 | 接收群内 @机器人 |
| `im:message:send_as_bot` | 以机器人身份发消息 | 回复消息/发卡片 |
| `im:message.reaction` | 添加/删除表情回复 | 👍 消息表情反应 |
| `application:application:patch` | 更新应用配置 | 扫码流程专用（强制 WebSocket） |

### 3.2 可能需要的额外权限

| 权限 | 说明 | 触发场景 |
|---|---|---|
| `im:message` | 消息读写全量权限 | 替代上面三个细粒度权限（更简单） |
| `im:chat:readonly` | 读取群聊信息 | 获取群名称/成员数等 |
| `im:resource` | 下载消息中的资源 | 下载用户发送的图片/文件 |
| `contact:user.base:readonly` | 读取用户基本信息 | 显示用户名称 |

### 3.3 权限申请方式

- **扫码流程**：`provision.ts` 的 `FEISHU_PROVISION_SCOPES` 数组自动申请
- **手动配置**：飞书开发者后台 → 应用 → 权限管理 → 开通权限

---

## 四、事件订阅

### 4.1 当前已订阅

| 事件 | 说明 | 订阅方式 |
|---|---|---|
| `im.message.receive_v1` | 接收消息 | `add_events` 参数 |

### 4.2 SDK 自动处理（无需显式订阅）

| 事件 | 说明 | 备注 |
|---|---|---|
| `card.action.trigger` | 卡片按钮/选择器点击 | WebSocket 模式下自动推送 |
| `im.message.reaction.created_v1` | 表情回复添加 | SDK 有 handler，未使用 |
| `im.message.reaction.deleted_v1` | 表情回复删除 | SDK 有 handler，未使用 |
| `im.chat.member.bot.added_v1` | 机器人被添加到群 | SDK 有 handler，未使用 |

### 4.3 事件订阅注意事项

- `add_events` 参数（`applicationConfig.patch` API）**只接受 IM 事件类型**
- `card.action.trigger` 是卡片回调事件，**不是 IM 事件**，不能放在 `add_events` 里（会 400 报错）
- 卡片回调在 WebSocket 长连接模式下自动推送，无需额外配置
- 新建应用（扫码流程）自动订阅 `im.message.receive_v1`
- 已有应用需要在开发者后台手动添加事件订阅

---

## 五、卡片回调安全机制

SDK 的 `SafetyPipeline` 对卡片回调有完整的安全处理：

| 机制 | 说明 |
|---|---|
| **去重** | `card:${messageId}:${openId}:${actionId}` 键去重，防止同一按钮被重复处理 |
| **锁** | per-chat 锁，防止同一聊天的并发回调冲突 |
| **队列** | per-chat 队列，保证同一聊天的回调按序处理 |

---

## 六、功能规划建议

按投入产出比排序：

### P0 — 优先实现

| 功能 | 组件 | 说明 |
|---|---|---|
| `/model` 下拉选择 | `select_static` | 当前要记 `provider/model` 字符串；改成下拉选择器，选项从 LLM registry 动态生成 |
| Reasoning 可折叠 | `collapsible` | 当前超 3000 字截断；用折叠组件默认折叠，点击展开 |
| 长工具输出可折叠 | `collapsible` | bash/read 等工具的长输出也适用 |

### P1 — 后续实现

| 功能 | 组件 | 说明 |
|---|---|---|
| `/new` 工作区选择 | `select_static` | 下拉列出可用工作区 |
| Step 卡片多列布局 | `column_set` | 左栏文字/右栏工具摘要，更紧凑 |
| 溢出菜单 | `overflow` | 卡片右上角「更多操作」：查看 status/清空上下文/导出 |
| `/status` 卡片增强 | `table` | 用表格组件展示 session 统计数据 |

### P2 — 探索性

| 功能 | 组件 | 说明 |
|---|---|---|
| 标签页多 step | `tab` | 多 step 结果分页查看 |
| 图表输出 | `chart` | 数据可视化（如果 agent 输出结构化数据） |
| 文本输入 | `input` | 卡片内嵌输入框，替代部分斜杠命令 |
| 文件导出 | `file` | 导出代码/文档为文件附件 |

---

## 七、已知限制

| 限制 | 值 | 说明 |
|---|---|---|
| 消息发送 QPS | 5 | 每秒最多 5 条消息（CardKit 流式更新可绕过） |
| 卡片大小 | 30KB | 单张卡片 JSON 不超过 30KB |
| 组件数量 | 200 | 单张卡片最多 200 个组件 |
| 流式卡片自动关闭 | 10 分钟 | CardKit 流式卡片超时自动关闭 |
| 文本流式频率 | 70ms/次 | CardKit 文本流式更新最小间隔 |

---

## 八、相关文档

- [飞书卡片 JSON 2.0 结构](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure.md)
- [卡片组件概述](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/component-json-v2-overview)
- [配置卡片交互](https://open.feishu.cn/document/feishu-cards/configuring-card-interactions.md)
- [发送消息 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create)
- [流式更新卡片概述](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview.md)
- [卡片回传交互回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication.md)
- [添加消息表情回复 API](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)
