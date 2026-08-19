# AGENTS.md — dsh-feishu

> 本插件基于 [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark)（commit `ee639df`，fork 时上游 HEAD）**独立维护**，不再跟踪 upstream 同步。上游 LICENSE（`Copyright (c) 2026 sugarforever`，MIT）已保留以满足 MIT 协议 modified-work 声明。
>
> 所有改动记录见 [CHANGELOG.md](./CHANGELOG.md) 的「Unreleased」段；**未对 DSH 源码做任何改动**。

## 包名与仓库

| | |
|---|---|
| npm 包名 | `@starxer/dsh-feishu` |
| GitHub | https://github.com/Starxer/dsh-feishu |
| 本地目录 | `~/workspace-lyf/deepseek-harness/workspace/dsh-lark`（保留旧名） |
| 上游来源 | `sugarforever/dsh-lark@ee639df`（fork 起点，不再同步） |

## 仓库结构

```
dsh-lark/
├── src/                 # 插件源码（独立维护的改动在这里）
├── tests/               # 单元测试（vitest）
├── client/              # 编译产物（web UI 客户端）
├── lib/                 # 编译产物（DSH host 端运行时）
├── docs/                # 架构文档
├── cordis.patch.yml     # 插件元数据（DSH loader 读取）
├── package.json         # name: @starxer/ds-feishu, link: pnpm link 到 DSH profile
└── CHANGELOG.md         # 本仓库的独立改动记录
```

`lib/` 与 `client/client.js` 由 `npm run build` 生成，不在 git 跟踪（`.gitignore`）。

## 构建

```sh
cd ~/workspace-lyf/deepseek-harness/workspace/dsh-lark
npm run build           # 同时产 lib/index.js + client/client.js
npm run typecheck
npm run test
```

## DSH 集成位置

| 文件 | 角色 |
|---|---|
| `~/.dsh/profiles/web/package.json` | pnpm link 引用本目录（`"@starxer/ds-feishu": "link:/home/lyf/workspace-lyf/deepseek-harness/workspace/dsh-lark"`） |
| `~/.dsh/profiles/web/cordis.patch.yml` | 启用 `lark-channel`（DSH loader 通过 plugin name 加载）|
| `~/.dsh/settings.yaml` | `lark-channel` section（`appId`、`appSecretRef`、`domain` 等） |
| `~/.dsh/.credentials.yaml` | `DSH_LARK_APP_SECRET: <secret>`（由 `appSecretRef` 引用） |

修改插件源码后必须：

```sh
npm run build           # 让 lib/index.js 同步
systemctl --user restart dsh
```

## 与上游关系

仓库创建时是 upstream `sugarforever/dsh-lark` 的 fork，但 **当前已不再跟踪上游同步**——见顶部说明。如需手工对比上游改动做 cherry-pick：

```sh
git remote add upstream https://github.com/sugarforever/dsh-lark.git
git fetch upstream
git log HEAD..upstream/main --oneline     # 上游新增（未合并）
git cherry-pick <upstream-commit-sha>     # 按需选 commit
```

上游当前节奏：单人 AI 辅助开发，release 频繁（v0.2.x 已发），单点风险高。**不建议大 merge 上游 main**——本仓库与上游已存在功能性分歧（DSH 兼容性、`/compact` 命令处理）。

## 关键坑（必读）

1. **不要注册 `name: "compact"` 命令**——DSH 自带 `command-compact` 插件同名，启动时抛 `command "compact" is already registered` 导致 boot 失败。详见 CHANGELOG 「Unreleased — Forked」。
2. **不要把 `'compaction'` 放进 `inject`**——DSH rc.7 把 `compaction-basic` 移进了 per-session preset realm，host 平面不再有全局 `compaction` 服务，插件会 `pending (waiting for service: compaction)` 无限等待、boot 失败。
3. **改动前先备份**（`cp src/<file>.ts src/<file>.ts.bak.$(date +%Y%m%d_%H%M%S)`），验证 dsh 启动正常后**手动删 `.bak.*`**——已经加入 `.gitignore`，避免意外提交。

## 测试

- `npm run test` 跑 vitest 单元测试（用 jsdom mock SDK），不依赖 DSH 真实运行
- 端到端验证：改完后 `systemctl --user restart dsh`，看 `journalctl --user -u dsh -n 30` 是否干净启动（`dsh web: http://127.0.0.1:3080`，无 `error|failed|already registered`）

## 关联记录

- 主项目工作区：`~/workspace-lyf/deepseek-harness/`（DSH 源码，本插件不修改此处）
- DSH 项目文档：`~/workspace-lyf/deepseek-harness/docs/architecture.md`
- 部署运维 skill：`~/.hermes/skills/autonomous-ai-agents/deepseek-harness-ops/`（含 rc.7 兼容性记录）