# Feishu / Lark 应用配置

## 扫码一键配置（推荐）

插件内置了飞书官方 `registerApp` 扫码建应用能力：

1. 启动 DSH Web Profile，打开 **Settings → 飞书与 Lark**。
2. 点击 **扫码配置**，用飞书 App 扫码并确认授权。
3. 插件自动获取 App ID 和 App Secret，配置权限和事件，建立连接。

## 手动创建应用

### 1. 创建自建应用

1. 打开飞书或 Lark 开发者后台。
2. 创建企业自建应用，填写名称、描述和图标。
3. 记录 App ID 和 App Secret。

### 2. 启用机器人

1. 进入"添加应用能力"。
2. 添加"机器人"能力。

### 3. 添加权限

必需权限：

| 权限标识 | 用途 |
|---|---|
| `im:message.p2p_msg:readonly` | 接收单聊消息 |
| `im:message.group_at_msg:readonly` | 接收群聊 @机器人消息 |
| `im:message:send_as_bot` | 以机器人身份发消息 |

如需关闭 @机器人 限制，额外申请 `im:message.group_msg`（通常需管理员审批）。

### 4. 配置事件

1. 进入"事件与回调" → "事件订阅"。
2. 选择"使用长连接接收事件"。
3. 添加事件 `im.message.receive_v1`。

### 5. 发布并安装

1. 创建应用版本并发布。
2. 安装到企业。
3. 在飞书中找到机器人发起单聊，或加入测试群。

## 配置凭据

### 通过 Settings 页面（推荐）

在 DSH Settings → 飞书与 Lark 中填写 App ID 和 App Secret。Secret 保存到 `$DSH_HOME/.credentials.yaml`，不会回显到浏览器。

### 通过环境变量

```sh
export DSH_LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
npx @deepseek-ai/dsh web
```

### 通过 Profile Patch

```yaml
- id: lark-channel
  config:
    appId: cli_xxxxxxxxxxxxxxxx
    appSecretRef: DSH_LARK_APP_SECRET
    domain: feishu
```

## 常见问题

| 问题 | 排查 |
|---|---|
| 启动鉴权失败 | App ID 和 App Secret 是否匹配 |
| 收不到消息 | 应用是否已发布安装、是否订阅 `im.message.receive_v1`、是否为长连接模式 |
| 群消息被忽略 | 是否 @了机器人、权限是否审批、`groupAllowlist` 是否允许 |
| 不能回复 | 检查 `im:message:send_as_bot` 权限和终端 API 错误 |
| 单聊被拒绝 | 检查 `dmMode` 和 `dmAllowlist` |
| 反复重连 | 检查网络/代理/防火墙，确保只有一个实例使用该应用 |
