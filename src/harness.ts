import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { conversationKey, summarizeTurn, toSessionId } from './conversation.ts'
import type { ConversationMessage } from './conversation.ts'
import type { DomainName } from './config.ts'

/** Minimum surface of {@link Agent} the conversation service depends on. */
interface AgentLike {
  session: { id: unknown; seq: number; events: readonly { seq: number; type: string; data: any }[] }
  whenIdle(): Promise<void>
  followup(message: ReturnType<typeof createUserMessage>): void
  steer(message: ReturnType<typeof createUserMessage>): void
  status: 'idle' | 'running'
}

interface AgentHandleLike { agent: AgentLike; dispose(): Promise<void> }

interface WorkspaceLike {
  path: string
  attachSession(sessionId: unknown): Promise<void>
}

export interface HarnessDependencies {
  agents: {
    create: (options: any) => Promise<AgentHandleLike>
    resume: (options: any) => Promise<AgentHandleLike>
    get: (id: ReturnType<typeof toSessionId>) => Agent | undefined
  }
  sessions: { flush(session: AgentLike['session']): Promise<unknown> }
  sessionPersistence: {
    list(): Promise<Array<{ id: string }>>
    /** Read a cold session's full log so the bridge can surface the same
     *  `session/title` and `turn/start` signals the webui's session list
     *  uses. Optional: when the deployment omits it (or hides the service
     *  behind cordis), cold sessions still list with no title. */
    readFrom?(id: unknown, fromSeq: number): Promise<{ meta: unknown; events: ReadonlyArray<{ seq: number; type: string; data: any }> }>
  }
  selection(): { provider: string; model: string; reasoningEffort?: ReasoningEffortId }
  agentPresets: {
    resolve(id?: string): Promise<{ id: string }>
    mount(agentCtx: import('@deepseek-ai/cordis').Context, id?: string): Promise<unknown>
  }
  workspaceRegistry: {
    list(): WorkspaceLike[]
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>
    /** Session ids hidden from listing surfaces (e.g. `/thread`); matches the
     *  workspace webui archive set so users see the same list in both places. */
    readonly archivedSessionIds: readonly string[]
  }
}

export interface HarnessBridgeConfig {
  domain: DomainName
  workspace?: string
  agentPreset?: string
  provider?: string
  model?: string
  /** Path to persist the chat→session override map across restarts. */
  statePath?: string
}

export interface InboundMessage extends ConversationMessage { content: string; imageBlocks?: readonly ImageAttachmentRef[] }

/** Per-chat creation options captured from the `/new` card flow or text
 *  command. Applied when the bridge creates the session agent, overriding
 *  the deployment-wide config defaults for workspace / preset / model. */
export interface ChatCreationOptions {
  workspace?: string
  agentPreset?: string
  provider?: string
  model?: string
  reasoningEffort?: ReasoningEffortId
}

export class HarnessConversationService {
  private readonly handles = new Map<string, Promise<AgentHandleLike>>()
  /**
   * Per-chat session override. `/new` and `/thread` redirect the chat's next
   * messages to a session that is not the deterministic hash of the chat
   * coordinates, so the user can start a fresh conversation or pick an old one
   * without spinning a new chat in Feishu.
   */
  private readonly chatToSession = new Map<string, string>()
  /**
   * Per-chat topic root message id (`rootId`), captured from inbound topic
   * messages. Feishu topic replies must target the topic ROOT message
   * (`replyTo: rootId` + `reply_in_thread: true`); replying to a non-root
   * topic message does not reliably land in the topic. Keyed by the same
   * chat key as `chatToSession`.
   */
  private readonly chatToRootId = new Map<string, string>()
  /**
   * Every chat key this bridge has ever seen (persisted). Together with
   * `chatToSession` it derives session ownership: a session is owned by the
   * chat key that maps to it explicitly, or — when that key has no explicit
   * override — by the chat key whose deterministic hash equals the session id.
   * `/thread` refuses to redirect a chat onto a session owned by another chat
   * so two dialog surfaces (main chat + topics) never share one session.
   */
  private readonly seenChatKeys = new Set<string>()
  /**
   * Per-chat creation options (workspace / preset / model) captured by the
   * `/new` card flow or the `/new <workspace> <preset> [model]` text command.
   * `createAgent` reads them when it spins up the session agent so a session
   * created through the card lands in the chosen workspace with the chosen
   * preset and model instead of the deployment-wide defaults. Keyed by the
   * same chat key as `chatToSession`.
   */
  private readonly chatToCreation = new Map<string, ChatCreationOptions>()
  /**
   * Sessions for which intermediate assistant message cards were sent during
   * the current turn. The channel skips the final reply card for these
   * sessions to avoid duplication.
   */
  private readonly intermediateSent = new Set<string>()

  constructor(private readonly deps: HarnessDependencies, private readonly config: HarnessBridgeConfig) {
    this.loadSessionMap()
  }

  /** Load persisted chat→session map from disk (if the file exists). */
  private loadSessionMap(): void {
    const path = this.config.statePath
    if (path === undefined || path === '') return
    try {
      const raw = readFileSync(path, 'utf-8')
      const data = JSON.parse(raw) as
        | Record<string, string>                 // legacy: { chatKey: sessionId }
        | { chatToSession?: Record<string, string>; seenChatKeys?: string[] }
      // Legacy format (pre-ownership): a flat record keyed by chat key.
      const legacy = Array.isArray(data) ? undefined
        : (data as Record<string, string>).chatToSession === undefined && !Array.isArray((data as any).seenChatKeys)
          ? data as Record<string, string>
          : undefined
      if (legacy !== undefined) {
        for (const [k, v] of Object.entries(legacy)) this.chatToSession.set(k, v)
        for (const k of Object.keys(legacy)) this.seenChatKeys.add(k)
        return
      }
      const parsed = data as { chatToSession?: Record<string, string>; seenChatKeys?: string[] }
      for (const [k, v] of Object.entries(parsed.chatToSession ?? {})) this.chatToSession.set(k, v)
      for (const k of parsed.seenChatKeys ?? []) this.seenChatKeys.add(k)
    } catch (error: unknown) {
      // ENOENT is expected on first run; log other errors
      if ((error as { code?: string }).code !== 'ENOENT') {
        console.error('dsh-feishu: loadSessionMap failed:', error instanceof Error ? error.message : String(error))
      }
    }
  }

  /** Persist the current chat→session map to disk (best-effort). */
  private saveSessionMap(): void {
    const path = this.config.statePath
    if (path === undefined || path === '') return
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({
        chatToSession: Object.fromEntries(this.chatToSession),
        seenChatKeys: [...this.seenChatKeys],
      }), 'utf-8')
    } catch (error: unknown) {
      console.error('dsh-feishu: saveSessionMap failed:', error instanceof Error ? error.message : String(error))
    }
  }

  async reply(message: InboundMessage): Promise<string> {
    const key = conversationKey(message)
    // Capture the topic root id so streaming/question/approval/todo cards
    // can reply into the same Feishu topic instead of the main chat stream.
    if (message.threadId !== undefined && message.rootId !== undefined) {
      this.chatToRootId.set(key, message.rootId)
    }
    const handle = await this.getOrCreate(key)
    const agent = handle.agent
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    const text = message.content
    const imageBlocks = message.imageBlocks ?? []
    const hasText = text.length > 0
    const hasImages = imageBlocks.length > 0
    if (!hasText && !hasImages) {
      // An inbound message must carry either text or at least one image; the
      // channel layer filters empties out, so this is defensive.
      throw new Error('dsh-feishu: cannot submit an empty user turn')
    }
    // Tag every Feishu user turn with a leading `[Feishu] ` marker so the
    // model and any later session-log reader can tell the message originated
    // from the Lark channel rather than the webui composer. Image-only
    // messages get the tag as a standalone text block because there is no
    // caption to attach it to.
    const tag = '[Feishu] '
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }> = []
    if (hasText) content.push({ type: 'text', text: `${tag}${text}` })
    else content.push({ type: 'text', text: tag })
    for (const attachment of imageBlocks) content.push({ type: 'image', attachment })
    agent.followup(createUserMessage({
      content,
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await this.deps.sessions.flush(agent.session)
    const result = summarizeTurn(agent.session.events, firstSeq)
    if (!result.ok) throw new Error('Harness turn did not produce a successful assistant response')
    return result.text
  }

  /**
   * Steer one message into a RUNNING agent turn (the DSH `next-step` inbox),
   * instead of queueing it as a new turn. Unlike {@link reply} this does not
   * wait for the agent to become idle — it injects into the live turn so the
   * model reacts immediately (matching the WebUI's steer gesture while busy).
   *
   * The target agent must already exist and be running; otherwise no turn can
   * receive the injection and the call throws a clear error.
   */
  async steer(message: InboundMessage): Promise<void> {
    const agent = await this.resolveAgent(message)
    if (agent === undefined) {
      throw new Error('没有运行中的 turn 可注入（该聊天尚未开始会话，请先发一条消息）')
    }
    if ((agent as unknown as AgentLike).status !== 'running') {
      throw new Error('当前没有运行中的 turn 可注入 —— 请直接发新消息（会排队为新轮），或用 /steer 在它运行时注入')
    }
    const text = message.content
    if (text.trim() === '') {
      throw new Error('steer 内容为空')
    }
    // Same `[Feishu] ` marker as reply() so the model and session log can tell
    // the injection came from the Lark channel rather than the webui composer.
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }> = []
    content.push({ type: 'text', text: `[Feishu] ${text}` })
    for (const attachment of (message.imageBlocks ?? [])) content.push({ type: 'image', attachment })
    ;(agent as unknown as AgentLike).steer(createUserMessage({
      content,
      source: { kind: 'user' },
    }))
    // Do NOT `await whenIdle()`: steering injects into the running turn and
    // returns immediately. The steered step renders through feishu-streaming.
  }

  /**
   * Resolve the agent backing one inbound message without creating one.
   * Slash-command handlers need a live agent to attach lifecycle events to;
   * silently spawning one would let the user run `/compact` against an empty
   * session and report "no compactable history yet" instead of an error.
   * @param message - inbound chat coordinates used to derive the session id.
   * @returns the existing agent for this chat, or `undefined` when no
   *   conversation has been started yet.
   */
  async resolveAgent(message: ConversationMessage): Promise<Agent | undefined> {
    const key = conversationKey(message)
    const sessionId = this.resolveSessionId(message)
    const live = this.deps.agents.get(sessionId as never)
    if (live !== undefined) return live
    const pending = this.handles.get(key)
    if (pending === undefined) return undefined
    try {
      // The handle's agent is the bridge's narrowed AgentLike; the command
      // runtime needs every Agent member, so cast through the structural
      // shape that the bridge already accepts.
      return (await pending).agent as unknown as Agent
    } catch {
      return undefined
    }
  }

  /**
   * Check if the agent for a chat is currently running (processing a turn).
   * Does NOT create an agent — returns false if no agent exists yet.
   */
  isAgentRunning(message: ConversationMessage): boolean {
    const sessionId = this.resolveSessionId(message)
    const live = this.deps.agents.get(sessionId as never)
    if (live === undefined) return false
    return (live as unknown as AgentLike).status === 'running'
  }

  async dispose(): Promise<void> {
    const handles = await Promise.allSettled(this.handles.values())
    await Promise.all(handles.flatMap(result => result.status === 'fulfilled' ? [result.value.dispose()] : []))
    this.handles.clear()
    this.chatToSession.clear()
    this.chatToRootId.clear()
    this.seenChatKeys.clear()
    this.chatToCreation.clear()
  }

  /**
   * Resolve the session id for one chat, honoring any `/new` or `/thread`
   * override before falling back to the deterministic hash. Centralizing the
   * lookup keeps `createAgent` / `setCurrentSelection` consistent.
   */
  /** Record a chat key and persist it on first sight, so default-derived
   *  session ownership survives restarts even when the chat never ran
   *  `/new` or `/thread`. */
  private recordChatKey(key: string): void {
    if (this.seenChatKeys.has(key)) return
    this.seenChatKeys.add(key)
    this.saveSessionMap()
  }

  private resolveSessionId(message: ConversationMessage): string {
    const key = conversationKey(message)
    this.recordChatKey(key)
    return this.chatToSession.get(key) ?? toSessionId(this.config.domain, key)
  }

  /**
   * Derive the chat key that owns one session id, or `undefined` when the
   * session is not owned by any chat this bridge knows about. Ownership has
   * two sources:
   *
   * 1. An explicit `/new` or `/thread` override in `chatToSession`.
   * 2. A chat key with no override whose deterministic hash equals the
   *    session id — i.e. the session the chat lands on by default. This is
   *    the subtle case: a topic that never ran `/new` still owns its
   *    default-derived session, so the main chat cannot `/thread` onto it and
   *    silently share it.
   *
   * Explicit overrides win over default derivation, so a chat that ran
   * `/new` no longer owns its old default session.
   */
  sessionOwnerKey(sessionId: string): string | undefined {
    for (const [key, mapped] of this.chatToSession) {
      if (mapped === sessionId) return key
    }
    for (const key of this.seenChatKeys) {
      if (!this.chatToSession.has(key) && toSessionId(this.config.domain, key) === sessionId) return key
    }
    return undefined
  }

  /**
   * Human-readable label for a chat key (used in ownership warnings).
   * `chat:<chatId>` is the main chat; `thread:<chatId>:<threadId>` is a topic.
   */
  describeChatKey(key: string): string {
    if (key.startsWith('thread:')) {
      const threadId = key.split(':')[2] ?? ''
      return threadId === '' ? '一个话题' : `话题(${threadId.slice(0, 8)}…)`
    }
    return '主聊天'
  }

  /**
   * Force-release one session so any dialog can `/thread` onto it. The
   * previous owner (if any) is reset to a brand-new session — the same
   * effect as running `/new` in that dialog — so it can never immediately
   * re-own the released session (including the default-derived case, where
   * merely deleting the override would let the chat re-own it on its next
   * message).
   *
   * @returns `{ kind: 'released', ownerLabel }` when a chat owned the
   *   session and was reset, or `{ kind: 'free' }` when no chat owned it.
   */
  detachSession(sessionId: string): { kind: 'released'; ownerLabel: string } | { kind: 'free' } {
    const owner = this.sessionOwnerKey(sessionId)
    if (owner === undefined) return { kind: 'free' }
    const ownerLabel = this.describeChatKey(owner)
    const newSessionId = toSessionId(this.config.domain, `${owner}\0detach-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
    this.chatToSession.set(owner, newSessionId)
    this.seenChatKeys.add(owner)
    this.saveSessionMap()
    this.handles.delete(owner)
    return { kind: 'released', ownerLabel }
  }

  /**
   * Attach this chat to an existing session, force-taking it over when
   * another dialog currently owns it. Used by the first-message onboarding
   * card: the user picks a session from the full list (occupied ones carry a
   * lock marker) and the previous owner is released via {@link detachSession}
   * before the session is rebound to this chat.
   *
   * @returns `'ok'` when bound, `'archived'` when the session is archived.
   */
  attachSession(message: ConversationMessage, sessionId: string): 'ok' | 'archived' {
    if (this.deps.workspaceRegistry.archivedSessionIds.includes(sessionId)) return 'archived'
    const key = conversationKey(message)
    const owner = this.sessionOwnerKey(sessionId)
    if (owner !== undefined && owner !== key) {
      // Force takeover: release the previous owner first.
      this.detachSession(sessionId)
    }
    this.chatToSession.set(key, sessionId)
    this.seenChatKeys.add(key)
    this.saveSessionMap()
    this.handles.delete(key)
    return 'ok'
  }

  /**
   * Whether this chat needs the first-message onboarding card (attach an
   * existing session or create a new one) instead of auto-creating a session.
   * A chat needs onboarding when it has no explicit `/new`/`/thread`/attach
   * override AND its default-derived session has no persisted history yet —
   * i.e. the dialog (or a fresh install) has never run a real conversation.
   */
  async needsOnboarding(message: ConversationMessage): Promise<boolean> {
    const key = conversationKey(message)
    if (this.chatToSession.has(key)) return false
    const defaultId = toSessionId(this.config.domain, key)
    const persisted = await this.deps.sessionPersistence.list()
    return !persisted.some(item => item.id === defaultId)
  }

  /** Read the creation options captured for one chat (if any). */
  creationOptionsFor(message: ConversationMessage): ChatCreationOptions | undefined {
    return this.chatToCreation.get(conversationKey(message))
  }

  /**
   * Reverse-lookup: given a session id, return the chat coordinates that own
   * it (honoring any active `/new` or `/thread` override). Used by the
   * Feishu questions listener, which receives session-keyed `question/requested`
   * frames from the apiproxy mux stream and needs to know which chat to render
   * the option card in. Returns `undefined` when the session is owned by no
   * chat — for example, a session created by the WebUI directly, which the
   * Lark channel has no business messaging.
   */
  resolveChat(sessionId: string): ConversationMessage | undefined {
    for (const [key, mapped] of this.chatToSession) {
      if (mapped === sessionId) return this.attachRootId(key, this.messageFromKey(key))
    }
    // No override: the session id is the deterministic hash of some chat key.
    // Hash prefixes are `lark-v2-<domain>:<key-hash>` (see `toSessionId`); we
    // cannot reverse the hash, but we can iterate the currently live agents
    // this bridge manages and find the one whose deterministic session id
    // matches. The bridge's `handles` keys are the chat keys themselves, so
    // we read them directly.
    for (const key of this.handles.keys()) {
      const derived = toSessionId(this.config.domain, key)
      if (derived === sessionId) return this.attachRootId(key, this.messageFromKey(key))
    }
    return undefined
  }

  /** Attach the stored topic root id (if any) to a reconstructed chat message. */
  private attachRootId(key: string, message: ConversationMessage): ConversationMessage {
    const rootId = this.chatToRootId.get(key)
    return rootId === undefined ? message : { ...message, rootId }
  }

  /**
   * Reconstruct a {@link ConversationMessage} from the chat key produced by
   * {@link conversationKey}. The key is sufficient for `resolveSessionId`
   * because only `chatId` and (optionally) `threadId` participate in the
   * hash; `chatType` is irrelevant for the session id and is filled with the
   * harmless `'p2p'` default.
   */
  private messageFromKey(key: string): ConversationMessage {
    if (key.startsWith('thread:')) {
      const [, chatId, threadId] = key.split(':')
      return { chatId: chatId ?? '', chatType: 'p2p', threadId: threadId ?? '' }
    }
    return { chatId: key.slice('chat:'.length), chatType: 'p2p' }
  }

  /**
   * Direct the chat to a fresh, never-used session id so the next regular
   * message starts a brand-new conversation. The previously bound session,
   * if any, is left untouched in the agents registry; the bridge just
   * forgets it. Returns the new session id.
   *
   * The new id is the deterministic hash of the chat key plus a
   * caller-supplied salt so two consecutive `/new` calls in the same chat
   * produce different sessions.
   */
  startNewSession(message: ConversationMessage, salt: string, options?: ChatCreationOptions): string {
    const key = conversationKey(message)
    const newSessionId = toSessionId(this.config.domain, `${key}\0${salt}`)
    this.chatToSession.set(key, newSessionId)
    this.seenChatKeys.add(key)
    if (options !== undefined) this.chatToCreation.set(key, options)
    this.saveSessionMap()
    this.handles.delete(key)
    return newSessionId
  }

  /**
   * Redirect the chat to an existing persisted session so the next regular
   * message resumes it. The session id must already exist in
   * `sessionPersistence` and must not be in the workspace archive set;
   * archived sessions are hidden from `/thread` so switching to one would
   * silently strand the next message on a session the user can no longer see.
   *
   * Refuses to redirect onto a session owned by a DIFFERENT chat key so two
   * dialog surfaces (main chat + topics) never share one session. Switching
   * back to a session the same chat already owns is a no-op success.
   *
   * @returns `'ok'` when the override was applied, `'archived'` when the
   *   session is archived (caller surfaces a translated rejection), and
   *   `'occupied'` when another chat key currently owns the session.
   */
  switchToSession(message: ConversationMessage, sessionId: string): 'ok' | 'archived' | 'occupied' {
    if (this.deps.workspaceRegistry.archivedSessionIds.includes(sessionId)) return 'archived'
    const key = conversationKey(message)
    const owner = this.sessionOwnerKey(sessionId)
    if (owner !== undefined && owner !== key) return 'occupied'
    this.chatToSession.set(key, sessionId)
    this.seenChatKeys.add(key)
    this.saveSessionMap()
    this.handles.delete(key)
    return 'ok'
  }

  /**
   * List every persisted session for this bridge's domain, newest first. The
   * session title comes from the latest `session/title` event on the live
   * agent's log when one is attached; cold sessions have no in-memory log to
   * read from so the title falls back to a short id-derived hint. The
   * `updatedAt` is the latest event timestamp.
   *
   * Sessions in the workspace archive set are filtered out so the chat listing
   * matches what the webui hides from its session tree. Live blank sessions
   * (DSH-created placeholders with no user turn yet) are also filtered. Cold
   * blank sessions remain visible because the bridge has no projection service
   * to read their `blank` bit.
   */
  async listSessions(): Promise<Array<{ id: string; updatedAt: number; title: string; ownedBy?: string }>> {
    const persisted = await this.deps.sessionPersistence.list()
    const archived = new Set(this.deps.workspaceRegistry.archivedSessionIds)
    const entries: Array<{ id: string; updatedAt: number; title: string; ownedBy?: string }> = []
    for (const item of persisted) {
      if (archived.has(item.id)) continue
      const live = this.deps.agents.get(item.id as never)
      let updatedAt = 0
      let title = ''
      let blank = false
      let events: ReadonlyArray<{ seq: number; type: string; data: any }> | undefined
      if (live !== undefined) {
        events = (live as unknown as AgentLike).session.events
      } else {
        // Cold session: ask SessionPersistence for the on-disk log via the same
        // readFrom primitive the webui's session list uses. The dependency
        // surface is widened lazily here so cold sessions still expose their
        // latest `session/title` event and `turn/start` bit.
        const readFrom = this.deps.sessionPersistence.readFrom
        if (typeof readFrom === 'function') {
          try {
            const result = await readFrom.call(this.deps.sessionPersistence, item.id as never, 0)
            events = result.events as ReadonlyArray<{ seq: number; type: string; data: any }>
            const metaTime = Number((result.meta as { createdAt?: number })?.createdAt ?? 0)
            if (metaTime > updatedAt) updatedAt = metaTime
          } catch {
            // No artifact, missing service, or cordis shadow mismatch: fall
            // through with no events and show the session without a title.
          }
        }
      }
      if (events !== undefined) {
        for (const event of events) {
          const seqTime = Number((event as { time?: number }).time ?? 0)
          if (seqTime > updatedAt) updatedAt = seqTime
          if (event.type === 'session/title') {
            const next = (event as { data?: { title?: unknown } }).data?.title
            if (typeof next === 'string' && next !== '') title = next
          }
        }
        blank = !events.some(event => event.type === 'turn/start')
      }
      if (blank) continue
      const ownerKey = this.sessionOwnerKey(item.id)
      entries.push({
        id: item.id,
        updatedAt,
        title,
        ...(ownerKey === undefined ? {} : { ownedBy: ownerKey }),
      })
    }
    entries.sort((left, right) => right.updatedAt - left.updatedAt)
    return entries
  }

  /**
   * Read the live metadata for one chat's current session: workspace path,
   * agent preset id, and current model selection. Used by the reply-card
   * footer and the `/status` command.
   *
   * Reads from the live agent's session events (persisted sessions) or
   * from the bridge's in-memory creation metadata. Returns empty strings
   * when the session has not been created yet.
   */
  async getSessionMeta(message: ConversationMessage): Promise<{
    sessionId: string; workspace: string; agentPreset: string; model: string; reasoningEffort: string; title: string
    turns: number; steps: number; toolCalls: number; inputTokens: number; outputTokens: number
    contextWindow: number; lastInputTokens: number
    cacheHitRate: number; ttftAvgMs: number; tokensPerSecond: number; llmDurationMs: number; toolDurationMs: number
  }> {
    const sessionId = this.resolveSessionId(message)
    let model = this.deps.selection()
    let reasoningEffort = model.reasoningEffort ? String(model.reasoningEffort) : ''
    const empty = { title: '', turns: 0, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, contextWindow: 0, lastInputTokens: 0, cacheHitRate: 0, ttftAvgMs: 0, tokensPerSecond: 0, llmDurationMs: 0, toolDurationMs: 0 }
    // Try reading the session header + events from persistence
    const readFrom = this.deps.sessionPersistence.readFrom
    if (typeof readFrom === 'function') {
      try {
        const result = await readFrom.call(this.deps.sessionPersistence, sessionId as never, 0)
        const header = result.meta as { cwd?: string; agentPreset?: string } | undefined
        const ws = header?.cwd ?? this.config.workspace ?? ''
        const preset = header?.agentPreset ?? this.config.agentPreset ?? ''
        const events = result.events as ReadonlyArray<{ type: string; data: any }>
        const stats = this.deriveSessionStats(events)
        // Prefer the latest request header recorded in the session log over the
        // bridge's in-memory selection ref: a WebUI model switch updates
        // apiProxy's selectionFor(agent).current without touching bridge.selections,
        // so the ref here can lag behind the model actually used in the last turn.
        let latestConfig: { provider?: string; model?: string; reasoningEffort?: string } | undefined
        for (const event of events) {
          if (event?.type === 'request/header' && event.data?.header?.config) {
            latestConfig = event.data.header.config
          }
        }
        if (latestConfig?.provider !== undefined && latestConfig?.model !== undefined) {
          const effort = latestConfig.reasoningEffort
          model = {
            provider: latestConfig.provider,
            model: latestConfig.model,
            ...(effort === undefined ? {} : { reasoningEffort: effort as ReasoningEffortId }),
          }
          reasoningEffort = effort ? String(effort) : ''
        }
        return { sessionId, workspace: ws, agentPreset: preset, model: `${model.provider}/${model.model}`, reasoningEffort, ...stats }
      } catch { /* fall through to config defaults */ }
    }
    return { sessionId, workspace: this.config.workspace ?? '', agentPreset: this.config.agentPreset ?? '', model: `${model.provider}/${model.model}`, reasoningEffort, ...empty }
  }

  /**
   * Derive session statistics from event log, mirroring the WebUI's
   * tokenUsage + contextPressure projections.
   *
   * Token accounting uses last-wins per turn/step (matching the WebUI's
   * `tokenUsageProjectionDefinition`): when an LLM step retries (same
   * turn+step), the later usage replaces the earlier one rather than
   * double-counting. `outputTokens` accumulates across all unique steps.
   * `inputTokens` = billed input (uncached + cacheRead + cacheWrite).
   *
   * Also processes `assistant/chunk` events with `chunk.type === 'usage'`
   * for early usage samples (same last-wins semantics per turn/step).
   */
  private deriveSessionStats(events: ReadonlyArray<{ type: string; data: any; time?: number }>): {
    title: string; turns: number; steps: number; toolCalls: number; inputTokens: number; outputTokens: number
    contextWindow: number; lastInputTokens: number
    cacheHitRate: number; ttftAvgMs: number; tokensPerSecond: number; llmDurationMs: number; toolDurationMs: number
  } {
    const turns = new Set<number>()
    let steps = 0
    let toolCalls = 0
    let title = ''
    let contextWindow = 0

    // Last-wins per turn/step for input tokens (matches WebUI projection).
    // key = `${turn}:${step}` → billed input tokens for that step.
    const stepInput = new Map<string, number>()
    let totalOutput = 0
    let totalCacheRead = 0
    let totalUncachedInput = 0

    // Track the latest usage sample for context % display.
    let lastInputTokens = 0

    // Timing: track per-step anchors for TTFT and decode.
    let stepStartTime = 0
    let firstTokenTime = 0
    let ttftSum = 0
    let ttftCount = 0
    let decodeMsSum = 0
    let outputForDecode = 0

    // Tool call timing: callId → startTime.
    const toolStarts = new Map<string, number>()
    let toolDurationMs = 0

    for (const event of events) {
      const t = event.time ?? 0
      if (event.type === 'turn/start') {
        turns.add((event.data?.turn as number | undefined) ?? turns.size)
      } else if (event.type === 'step/start') {
        steps++
        stepStartTime = t
        firstTokenTime = 0
      } else if (event.type === 'assistant/chunk') {
        const chunk = event.data?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0 && firstTokenTime === 0) {
          firstTokenTime = t
        }
      } else if (event.type === 'tool/call') {
        toolCalls++
        const callId = event.data?.callId as string | undefined
        if (callId !== undefined) toolStarts.set(callId, t)
      } else if (event.type === 'tool/result') {
        const callId = event.data?.message?.source?.callId as string | undefined
        if (callId !== undefined) {
          const start = toolStarts.get(callId)
          if (start !== undefined && t > start) {
            toolDurationMs += t - start
            toolStarts.delete(callId)
          }
        }
      } else if (event.type === 'assistant/message' || (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage')) {
        const turn = event.data?.turn as number | undefined
        const step = event.data?.step as number | undefined
        // For assistant/message, usage is at data.usage; for assistant/chunk, at data.chunk.usage
        const usage = event.type === 'assistant/message'
          ? event.data?.usage
          : event.data?.chunk?.usage
        if (usage !== undefined && usage !== null) {
          const iTokens = usage.inputTokens as number | undefined
          const oTokens = usage.outputTokens as number | undefined
          const crTokens = (usage.cacheReadTokens ?? 0) as number
          const cwTokens = (usage.cacheWriteTokens ?? 0) as number
          if (turn !== undefined && step !== undefined && iTokens !== undefined) {
            // Last-wins: replace previous value for same turn+step.
            const key = `${turn}:${step}`
            const billed = iTokens + crTokens + cwTokens
            stepInput.set(key, billed)
          }
          if (oTokens !== undefined) totalOutput += oTokens
          if (iTokens !== undefined) {
            lastInputTokens = iTokens + crTokens + cwTokens
            totalUncachedInput += iTokens
            totalCacheRead += crTokens
          }
        }
        // TTFT and decode time for assistant/message events.
        if (event.type === 'assistant/message' && stepStartTime > 0) {
          if (firstTokenTime > 0 && firstTokenTime >= stepStartTime) {
            ttftSum += firstTokenTime - stepStartTime
            ttftCount++
          }
          if (firstTokenTime > 0 && t > firstTokenTime) {
            decodeMsSum += t - firstTokenTime
            const oTokens = usage?.outputTokens as number | undefined
            if (oTokens !== undefined) outputForDecode += oTokens
          }
        }
      } else if (event.type === 'session/title') {
        const next = event.data?.title
        if (typeof next === 'string' && next !== '') title = next
      } else if (event.type === 'request/context') {
        const cw = event.data?.contextWindow as number | undefined
        if (cw !== undefined && cw > 0) contextWindow = cw
      }
    }

    // Sum the surviving (non-replaced) per-step input tokens.
    let inputTokens = 0
    for (const v of stepInput.values()) inputTokens += v

    // Derived metrics.
    const totalInputForCache = totalUncachedInput + totalCacheRead
    const cacheHitRate = totalInputForCache > 0 ? Math.round(totalCacheRead / totalInputForCache * 100) : 0
    const ttftAvgMs = ttftCount > 0 ? Math.round(ttftSum / ttftCount) : 0
    const tokensPerSecond = decodeMsSum > 0 && outputForDecode > 0
      ? Math.round(outputForDecode / (decodeMsSum / 1000))
      : 0
    const llmDurationMs = decodeMsSum + ttftSum


    return { title, turns: turns.size, steps, toolCalls, inputTokens, outputTokens: totalOutput, contextWindow, lastInputTokens, cacheHitRate, ttftAvgMs, tokensPerSecond, llmDurationMs, toolDurationMs }
  }

  /** Mark a session as having sent intermediate assistant message cards. */
  markIntermediateSent(sessionId: string): void {
    this.intermediateSent.add(sessionId)
  }

  /** Check and consume the intermediate-sent flag for a session. Returns true if intermediate cards were sent. */
  consumeIntermediateSent(sessionId: string): boolean {
    if (!this.intermediateSent.has(sessionId)) return false
    this.intermediateSent.delete(sessionId)
    return true
  }

  /** Resolve the session id for a chat message (used by streaming module). */
  resolveSessionIdFor(message: ConversationMessage): string {
    return this.resolveSessionId(message)
  }

  /** Marker kept to silence trailing whitespace edits. */
  private getOrCreate(key: string): Promise<AgentHandleLike> {
    let pending = this.handles.get(key)
    if (pending !== undefined) return pending
    pending = this.createAgent(key).catch((error: unknown) => {
      this.handles.delete(key)
      throw error
    })
    this.handles.set(key, pending)
    return pending
  }

  private async createAgent(key: string): Promise<AgentHandleLike> {
    // The chat key is `chat:<chatId>` or `thread:<chatId>:<threadId>`; build a
    // minimal ConversationMessage so `resolveSessionId` can honor the chat→session
    // override populated by `/new` or `/thread`.
    const creation = this.chatToCreation.get(key)
    const sessionId = this.resolveSessionId(this.messageFromKey(key))
    const liveAgent = this.deps.agents.get(sessionId as never)
    if (liveAgent !== undefined) {
      // The session controller maintains its own WeakMap<Agent, InstalledSelection>
      // via the apiproxy replacement; live agent selection is owned upstream.
      // The plugin just hands the live agent back.
      return { agent: liveAgent as unknown as AgentLike, dispose: async () => undefined }
    }
    const fallback = this.deps.selection()
    const initial = {
      provider: creation?.provider ?? this.config.provider ?? fallback.provider,
      model: creation?.model ?? this.config.model ?? fallback.model,
      ...(creation?.reasoningEffort !== undefined
        ? { reasoningEffort: creation.reasoningEffort }
        : fallback.reasoningEffort !== undefined
          ? { reasoningEffort: fallback.reasoningEffort }
          : {}),
    } satisfies ModelSelection
    const configuredWorkspace = creation?.workspace ?? this.config.workspace
    const workspace = configuredWorkspace === undefined
      ? this.deps.workspaceRegistry.list()[0]
      : await this.deps.workspaceRegistry.resolveByPath(configuredWorkspace)
    // Use the workspace's actual path as cwd to ensure consistency
    // When no workspace is configured, use the first workspace's path
    const cwd = workspace?.path ?? configuredWorkspace ?? process.cwd()
    const agentPreset = (await this.deps.agentPresets.resolve(creation?.agentPreset ?? this.config.agentPreset)).id
    const setup = async (agentCtx: import('@deepseek-ai/cordis').Context) => {
      await this.deps.agentPresets.mount(agentCtx, agentPreset)
    }
    const persisted = (await this.deps.sessionPersistence.list()).some(item => item.id === sessionId)
    const handle = persisted
      ? await this.deps.agents.resume({ resumeSessionId: sessionId, agentOptions: initial, setup })
      : await this.deps.agents.create({
        sessionId,
        meta: { cwd, agentPreset },
        agentOptions: initial,
        setup,
      })
    // Only attach workspace for newly created sessions. Persisted sessions
    // are already attached to their original workspace and re-attaching
    // fails when the cwd stored in the session header doesn't match the
    // current config's workspace path.
    if (!persisted) {
      try {
        await workspace?.attachSession(sessionId)
      } catch (error: unknown) {
        await handle.dispose()
        throw error
      }
    }
    return handle
  }
}
