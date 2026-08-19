# Changelog

## Unreleased

本仓库基于 [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark) HEAD（`ee639df`）独立维护，**不再跟踪 upstream 同步**。所有改动仅修改本仓库文件，**未对 DSH 源码（`~/workspace-lyf/deepseek-harness/packages/*`、`vendor/*`）做任何改动**。上游 LICENSE（MIT, Copyright (c) 2026 sugarforever）保留以满足 MIT modified-work 声明。

### 兼容性

- 适配 DeepSeek Harness `0.1.0-rc.7`（2026-08-18 升级）：移除对 host-plane `compaction` 服务的依赖（rc.7 的 preset 架构把 `compaction-basic` 移进了 per-session preset realm，host 平面不再有全局 `compaction`）。

### 命令注册

- 移除 `/compact` 命令（飞书聊天内）：与 DSH 自带 `command-compact` 插件同名（`name: "compact"`），DSH 启动时两个注册会抛 `command "compact" is already registered` 导致插件崩溃、boot 失败。DSH web UI 仍可通过 DSH 自带 `command-compact` 使用 `/compact`。
- `/model`、`/stop` 保留。
- `inject` 数组去掉 `'compaction'`；`apply()` 中不再 `ctx.get('compaction')`；`executeSlashCommand` 不再传 `_compaction` 参数。

### dsh 启动必需配置

- `~/.dsh/profiles/web/cordis.patch.yml` 必须启用 `compaction-basic` + `command-compact`（拉回 host plane），否则 DSH 自带 `/compact` 命令在 web UI 上也不可用。
- 启用 `lark-channel`（无特殊要求，前提是上方 `command-compact` 已启用）。

### 命名与仓库迁移

- GitHub 仓库：`Starxer/dsh-lark`（fork）→ `Starxer/dsh-feishu`（独立仓库）
- npm 包名：`@starxer/ds-feishu` → `@starxer/dsh-feishu`
- 本地目录保留 `workspace/dsh-lark`（不改名，避免影响 `~/.dsh/profiles/web/package.json` 的 pnpm link 路径）
- 与上游分叉：移除 `/compact` 命令与上游设计哲学冲突，无法反向合并回 upstream

### Bug 修复

- 备份与临时文件清理：删除了 `src/commands.ts.bak.*` 和 `src/index.ts.bak.*`（编译时调试产物，已 gitignore 防止再次产生）。

## Unreleased

- Add an emoji reaction (`reactEmoji`, default `THUMBSUP`) to each inbound message as an immediate acknowledgement; set it to an empty string to disable. A failed reaction logs a warning without blocking the reply.
- Register three chat-side slash commands that bridge into the Harness command plane: `/model` (show, list, fuzzy-search by keyword, or switch the active default model through Harness Settings), `/compact` (call `ctx.compaction.compactNow()` against the chat's existing Agent), and `/stop` (call `agent.cancel({ kind: 'user' })` to abort the running turn). `/model` and `/compact` require that the chat has sent at least one ordinary message first so a session already exists.

## 0.2.2

- Restore npm 12 lockfile entries required for clean Linux CI installs.

## 0.2.1

- Mark Harness-provided peer dependencies as optional for package-manager resolution, avoiding misleading missing-peer warnings in DSH Profiles.
- Keep the supported Harness range starting at `0.1.0-rc.6` while validating development and release builds against `0.1.0-rc.7`.
- Add continuous compatibility checks against the latest published Harness packages.

## 0.2.0

- Contribute an embedded **Feishu & Lark** section to Harness Settings through the plugin web client.
- Require same-origin browser requests for settings and credential mutations.
- Store App Secret through Harness Credentials using `DSH_LARK_APP_SECRET` by default.
- Apply Settings and credential changes by replacing the Lark channel without restarting Harness.
- Keep the plugin active but idle until required application credentials are configured.
- Show explicit configured and missing App Secret states without returning the secret to the browser.
- Populate linked Provider and Model selectors from the current Harness model catalog.
- Resume persisted Lark sessions after restart and reuse an already-live Agent when available.
- Print initial connection, channel, and message-handling failures to the terminal as well as the Harness logger, with App Secret redaction.
- Remove the generic configuration-file action from the Lark-focused Settings experience.

## 0.1.1

- Mount the Harness default or configured Agent Preset for Lark sessions.
- Associate Lark sessions with an explicit Workspace or the first registered Workspace.
- Start corrected sessions with a v2 identity so legacy uncomposed sessions are not reused.

## 0.1.0

- Initial Feishu/Lark WebSocket Channel integration for DeepSeek Harness.
- Stable chat/thread to Harness Session mapping.
- Official SDK policy, deduplication, stale-event filtering, and per-chat queue reuse.
