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

The official Channel owns transport and ingress safety. `chatQueue.enabled` prevents overlapping handlers in the same chat, deduplication suppresses repeated event delivery, and a five-minute stale window avoids processing delayed events as new requests. Cordis disposal removes listeners, disconnects the WebSocket, flushes completed turns, and disposes owned Agents.
