# Architecture

```text
Feishu/Lark user
      │ im.message.receive_v1
      ▼
Official Lark Channel (WebSocket, reconnect, dedup, policy, chat queue)
      │ NormalizedMessage
      ▼
dsh-lark conversation adapter
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

Inbound messages starting with `/<name>` are routed through the Harness command plane instead of the Agent. The plugin injects `commands`, `compaction`, and `llm` and registers three commands:

- `/model` — reports, lists, or switches the active default model. The handler reads `ctx.llm.listProviders()` and `ctx.llm.listModels()` to enumerate routes, and writes new selections through `AgentDefaultModelConfig.saveSelection()`. A bare keyword with no `/` falls through to a case-insensitive fuzzy search across provider ids, model ids, and model names, marking the current selection.
- `/compact` — forwards to `ctx.compaction.compactNow()` against the chat's existing Agent. The command requires the chat to have already produced an Agent (send one ordinary message first); otherwise it returns an explanatory error instead of silently creating one.
- `/stop` — calls `agent.cancel({ kind: 'user' })` to abort the running turn. The chat stays usable; the next inbound message opens a new turn. When the agent is already idle the command reports a no-op success rather than failing.

`commands.execute()` requires a live `Agent`; `HarnessConversationService.resolveAgent()` reuses `agents.get()` or an in-flight handle for the chat's conversation key without spawning a new session, so `/compact` against an empty chat returns a clear "send a message first" reply rather than "no compactable history yet". Slash-command failures fall through to the configured `errorMessage` fallback so users never see Harness-internal stack traces.
