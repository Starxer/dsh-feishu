# DeepSeek Harness Lark Channel Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or execute inline with superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a DeepSeek Harness Cordis plugin that lets users converse with a Harness agent from Feishu or Lark through the official Node SDK's WebSocket long connection.

**Architecture:** The plugin owns one official `createLarkChannel()` instance and maps each Lark chat or thread to one stable Harness session. Incoming normalized messages are submitted to an in-process Harness Agent; after the Agent becomes idle, the adapter extracts only the assistant text committed during that turn and replies through the same Channel. Harness owns model choice, tools, agent execution, and durable sessions; the Lark SDK owns WebSocket transport, reconnection, deduplication, mention policy, message normalization, and outbound formatting.

**Tech Stack:** TypeScript, Cordis, DeepSeek Harness public services, `@larksuiteoapi/node-sdk` Channel API, Schemastery, Vitest, tsdown.

## Global Constraints

- Event transport is the official Lark/Feishu WebSocket long connection; no public webhook server is required.
- App credentials are read from plugin configuration via environment-backed Cordis patch expressions and are never logged.
- One normalized Lark conversation key maps deterministically to one Harness `SessionId`.
- Group messages require an explicit bot mention by default; direct messages are enabled by default.
- Lark SDK safety policy owns duplicate/stale event handling and per-chat serialization.
- The plugin replies only with assistant text produced after the current inbound message was queued.
- A failed Agent turn produces a bounded user-facing error without exposing secrets or stack traces.
- Channel listeners, WebSocket connection, Agents, and sessions are released or flushed on Cordis disposal.
- Every production behavior begins with a failing test and follows red-green-refactor.

---

### Task 1: Package shell and validated configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.types.json`
- Create: `tsdown.config.ts`
- Create: `vitest.config.ts`
- Create: `src/config.ts`
- Test: `tests/config.spec.ts`

**Interfaces:**
- Produces `Config` and `ConfigSchema` with `appId`, `appSecret`, `domain`, mention/access policy, optional model override, workspace, and safe error text.

- [ ] Write failing schema tests for required credentials, defaults, Feishu/Lark domains, allowlists, and bounded error text.
- [ ] Run the focused test and confirm it fails because `src/config.ts` is absent.
- [ ] Add package/build configuration and the minimal schema implementation.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Conversation identity and turn result projection

**Files:**
- Create: `src/conversation.ts`
- Test: `tests/conversation.spec.ts`

**Interfaces:**
- Produces `conversationKey(message)`, `toSessionId(key)`, and `summarizeTurn(events, firstSeq)`.
- Session identity uses a SHA-256 digest of the Lark domain plus chat/thread identity so raw external identifiers are not persisted in IDs.

- [ ] Write failing tests for direct/group/thread key separation, deterministic bounded session IDs, current-turn text selection, and error outcomes.
- [ ] Run the focused test and confirm missing exports are the failure cause.
- [ ] Implement pure mapping and event summarization helpers.
- [ ] Re-run and refactor while green.

### Task 3: Harness Agent conversation bridge

**Files:**
- Create: `src/harness.ts`
- Test: `tests/harness.spec.ts`

**Interfaces:**
- Produces `HarnessConversationService.reply(message): Promise<string>` and `dispose(): Promise<void>`.
- Consumes `agents`, `sessions`, `agentDefaultModel`, `createUserMessage`, and optional configured provider/model.

- [ ] Write failing tests for lazy Agent creation, same-chat reuse, different-chat isolation, concurrent serialization, session flush, model override, and safe turn failures.
- [ ] Run the focused test and verify the bridge is missing.
- [ ] Implement the smallest in-process Agent adapter that waits for idle before/after `followup()`.
- [ ] Re-run focused tests and refactor while green.

### Task 4: Official Lark Channel lifecycle plugin

**Files:**
- Create: `src/channel.ts`
- Create: `src/index.ts`
- Test: `tests/plugin.spec.ts`

**Interfaces:**
- `apply(ctx, config)` creates one Channel with `transport: 'websocket'`, installs policy/safety defaults, registers `message` and diagnostic listeners, then connects.
- Incoming messages call the Harness bridge and reply with `channel.send(chatId, { markdown }, { replyTo, replyInThread })`.

- [ ] Write a failing lifecycle test for Channel options, message reply routing, error fallback, connect failure, diagnostics, and disconnect/disposal.
- [ ] Run it and confirm the plugin surface is absent.
- [ ] Implement the Channel factory seam and Cordis lifecycle.
- [ ] Re-run focused and complete test suites.

### Task 5: Bundle patch, usage documentation, and release verification

**Files:**
- Create: `cordis.patch.yml`
- Create: `.env.example`
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/feishu-setup.md`
- Create: `CHANGELOG.md`
- Create: `LICENSE`
- Test: `tests/package.spec.ts`

**Interfaces:**
- Package exports one DSH Host plugin and contributes a disabled-by-default documented patch instance using `FEISHU_APP_ID` and `FEISHU_APP_SECRET`.

- [ ] Write a failing package smoke test for exported files, scripts, bundle metadata, and secret-free examples.
- [ ] Add setup instructions for app creation, bot capability, `im.message.receive_v1`, permissions, WebSocket event mode, installation, and troubleshooting.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `npm pack --dry-run`.

## Self-review

- Spec coverage: DSH plugin packaging, Feishu/Lark WebSocket long connection, official SDK reuse, durable conversation continuity, policy defaults, lifecycle cleanup, setup documentation, and verification each have an owning task.
- Placeholder scan: no deferred implementation placeholders are present; runtime credentials are intentionally environment-supplied.
- Type consistency: normalized messages feed a pure conversation key, the Harness bridge returns one Markdown string, and only the Channel layer performs network output.
