# Architecture

```text
Feishu/Lark user
      │ im.message.receive_v1
      ▼
Official Lark Channel (WebSocket, reconnect, dedup, policy, chat queue)
      │ NormalizedMessage
      ▼
dsh-feishu conversation adapter
      │ chat/thread → opaque SessionId
      ▼
Workspace selection + Agent Preset composition
      │ cwd + mounted tools/system prompt
      ▼
Harness Agent (selected model, tools, system prompt, session log)
      │ current turn assistant text
      ▼
Official Channel.send() → reply to original message/thread
```

The plugin runs inside the Harness Host. It does not launch another Harness process and does not expose an HTTP endpoint. A lazy Agent is created for each conversation key and reused for later messages. Before creation, the plugin resolves the configured Agent Preset (or the Harness default), selects the configured Workspace (or the first registered Workspace), records both in session metadata, mounts the preset in the Agent scope, and attaches the Session to the matching Workspace. `agent.whenIdle()` brackets each submitted prompt; only assistant events at or after the captured starting sequence are eligible for the reply.

The official Channel owns transport and ingress safety. `chatQueue.enabled` prevents overlapping handlers in the same chat, deduplication suppresses repeated event delivery, and a five-minute stale window avoids processing delayed events as new requests. On each accepted message the plugin first adds the configured emoji reaction (`reactEmoji`, default `THUMBSUP`; empty disables it) as a best-effort acknowledgement — a reaction failure is logged and never blocks the reply. Cordis disposal removes listeners, disconnects the WebSocket, flushes completed turns, and disposes owned Agents.

## Chat-side slash commands

Inbound messages starting with `/<name>` are routed through the Harness command plane instead of the Agent. The plugin injects `commands` and `llm` (the `compaction` service is intentionally **not** injected — see AGENTS.md「关键坑」) and registers the chat-facing commands:

- `/model` — reports, lists, or switches the active default model. The handler reads `ctx.llm.listProviders()` and `ctx.llm.listModels()` to enumerate routes, and writes new selections through `AgentDefaultModelConfig.saveSelection()`. A bare keyword with no `/` falls through to a case-insensitive fuzzy search across provider ids, model ids, and model names, marking the current selection.
- `/new [--workspace <path>] [--preset <id>]` — starts a new conversation in the chat; optionally pins the workspace and agent preset for that new session (persisted — takes effect only on the new session, never a running one).
- `/thread [N]` — lists persisted sessions, or switches the chat to one by index. Archived sessions are filtered out and rejected on switch.
- `/help` — lists every slash command currently registered on the receiving agent (including DSH's own `compact` / `goal` / `feedback` / `export`).
- `/status` — shows the WebUI session state: id/title/last-active, workspace, agent preset, current model, running status, archived.
- `/approve` / `/deny` / `/approvals` — settle pending tool approvals (shared with the Feishu approval card).
- `/stop` — calls `agent.cancel({ kind: 'user' })` to abort the running turn. The chat stays usable; the next inbound message opens a new turn. When the agent is already idle the command reports a no-op success rather than failing.

> `/compact` is **not** registered here: it would collide with DSH's own `command-compact` plugin (`name: "compact"`) and fail boot with `command "compact" is already registered`. Use the WebUI's `/compact`, which routes through DSH's own command-compact once `compaction-basic` + `command-compact` are pulled back to the host plane in `~/.dsh/profiles/web/cordis.patch.yml`.

`commands.execute()` requires a live `Agent`; `HarnessConversationService.resolveAgent()` reuses `agents.get()` or an in-flight handle for the chat's conversation key without spawning a new session, so slash commands against an empty chat return a clear "send a message first" reply rather than silently creating an empty session. Slash-command failures fall through to the configured `errorMessage` fallback so users never see Harness-internal stack traces.

## Reply cards

Every final assistant turn is rendered as a Feishu interactive card (`channel.ts` `{ card }`), with a read-only footer naming the session's **workspace path** and **agent preset** (the "mode"). This footer is injected by the plugin from session metadata (`cwd` / `agentPreset`, persisted in the session header) — **no LLM call** and no model tokens are consumed for it.
