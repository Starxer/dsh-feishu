import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
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
  status: 'idle' | 'running'
}

interface AgentHandleLike { agent: AgentLike; dispose(): Promise<void> }

/**
 * Mutable reference consumed by `installModelSelection`. The agent loop reads
 * `current` on every `system-prompt/assemble` waterfall, so a `/model` command
 * mutating this in place takes effect on the next inbound message without
 * rebuilding the agent or disposing its session.
 */
interface LiveSelection {
  current: ModelSelection | undefined
  assembled: ModelSelection | undefined
}

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
    mount(agentCtx: Parameters<typeof installModelSelection>[0], id?: string): Promise<unknown>
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

export class HarnessConversationService {
  private readonly handles = new Map<string, Promise<AgentHandleLike>>()
  /**
   * Per-session live selection refs handed to `installModelSelection`.
   * A `/model` switch mutates `ref.current` directly so the agent loop's
   * next `system-prompt/assemble` waterfall picks up the new provider/model
   * without forcing a session rebuild.
   */
  private readonly selections = new Map<string, LiveSelection>()
  /**
   * Per-chat session override. `/new` and `/thread` redirect the chat's next
   * messages to a session that is not the deterministic hash of the chat
   * coordinates, so the user can start a fresh conversation or pick an old one
   * without spinning a new chat in Feishu.
   */
  private readonly chatToSession = new Map<string, string>()
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
      const data = JSON.parse(raw) as Record<string, string>
      for (const [k, v] of Object.entries(data)) this.chatToSession.set(k, v)
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
      writeFileSync(path, JSON.stringify(Object.fromEntries(this.chatToSession)), 'utf-8')
    } catch (error: unknown) {
      console.error('dsh-feishu: saveSessionMap failed:', error instanceof Error ? error.message : String(error))
    }
  }

  async reply(message: InboundMessage): Promise<string> {
    const key = conversationKey(message)
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
    this.selections.clear()
    this.chatToSession.clear()
  }

  /**
   * Resolve the session id for one chat, honoring any `/new` or `/thread`
   * override before falling back to the deterministic hash. Centralizing the
   * lookup keeps `createAgent` / `setCurrentSelection` consistent.
   */
  private resolveSessionId(message: ConversationMessage): string {
    const key = conversationKey(message)
    return this.chatToSession.get(key) ?? toSessionId(this.config.domain, key)
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
      if (mapped === sessionId) return this.messageFromKey(key)
    }
    // No override: the session id is the deterministic hash of some chat key.
    // Hash prefixes are `lark-v2-<domain>:<key-hash>` (see `toSessionId`); we
    // cannot reverse the hash, but we can iterate the currently live agents
    // this bridge manages and find the one whose deterministic session id
    // matches. The bridge's `handles` keys are the chat keys themselves, so
    // we read them directly.
    for (const key of this.handles.keys()) {
      const derived = toSessionId(this.config.domain, key)
      if (derived === sessionId) return this.messageFromKey(key)
    }
    return undefined
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
   * Mutate the cached selection ref for one chat so the next `agent/request`
   * routed through the agent loop picks up the new provider/model. Returns
   * the previously cached value when this chat already owns a ref, so the
   * caller can surface a diff if needed.
   *
   * `/model` callers persist the change through `agentDefaultModel.saveSelection`
   * first; this method is only the in-memory flip that closes the
   * "settings wrote, agent still routes to the old model" gap.
   *
   * @param message - inbound chat coordinates whose selection should change.
   * @param next - replacement provider/model pair (and optional reasoning effort).
   * @returns the previous cached selection, or `undefined` when no ref exists.
   */
  setCurrentSelection(message: ConversationMessage, next: ModelSelection): ModelSelection | undefined {
    const sessionId = this.resolveSessionId(message)
    const ref = this.selections.get(sessionId)
    if (ref === undefined) return undefined
    const previous = ref.current
    ref.current = next
    return previous
  }

  /**
   * Read the currently selected provider/model pair for one chat, useful for
   * the `/model` command's status output without re-reading the global
   * `agentDefaultModel` (which would not reflect per-chat mutations made by
   * `setCurrentSelection`).
   * @param message - inbound chat coordinates to inspect.
   * @returns the current selection, or `undefined` when the chat has no ref yet.
   */
  currentSelectionFor(message: ConversationMessage): ModelSelection | undefined {
    const sessionId = this.resolveSessionId(message)
    return this.selections.get(sessionId)?.current
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
  startNewSession(message: ConversationMessage, salt: string): string {
    const key = conversationKey(message)
    const newSessionId = toSessionId(this.config.domain, `${key}\0${salt}`)
    this.chatToSession.set(key, newSessionId)
    this.saveSessionMap()
    this.handles.delete(key)
    this.selections.delete(newSessionId)
    return newSessionId
  }

  /**
   * Redirect the chat to an existing persisted session so the next regular
   * message resumes it. The session id must already exist in
   * `sessionPersistence` and must not be in the workspace archive set;
   * archived sessions are hidden from `/thread` so switching to one would
   * silently strand the next message on a session the user can no longer see.
   *
   * @returns `true` when the override was applied, `false` when the session is
   *   archived (the caller should surface a translated rejection).
   */
  switchToSession(message: ConversationMessage, sessionId: string): boolean {
    if (this.deps.workspaceRegistry.archivedSessionIds.includes(sessionId)) return false
    const key = conversationKey(message)
    this.chatToSession.set(key, sessionId)
    this.saveSessionMap()
    this.handles.delete(key)
    this.selections.delete(sessionId)
    return true
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
  async listSessions(): Promise<Array<{ id: string; updatedAt: number; title: string }>> {
    const persisted = await this.deps.sessionPersistence.list()
    const archived = new Set(this.deps.workspaceRegistry.archivedSessionIds)
    const entries: Array<{ id: string; updatedAt: number; title: string }> = []
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
      entries.push({ id: item.id, updatedAt, title })
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
  }> {
    const sessionId = this.resolveSessionId(message)
    const model = this.selections.get(sessionId)?.current ?? this.deps.selection()
    const reasoningEffort = model.reasoningEffort ? String(model.reasoningEffort) : ''
    const empty = { title: '', turns: 0, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, contextWindow: 0, lastInputTokens: 0 }
    // Try reading the session header + events from persistence
    const readFrom = this.deps.sessionPersistence.readFrom
    if (typeof readFrom === 'function') {
      try {
        const result = await readFrom.call(this.deps.sessionPersistence, sessionId as never, 0)
        const header = result.meta as { cwd?: string; agentPreset?: string } | undefined
        const ws = header?.cwd ?? this.config.workspace ?? ''
        const preset = header?.agentPreset ?? this.config.agentPreset ?? ''
        const stats = this.deriveSessionStats(result.events as ReadonlyArray<{ type: string; data: any }>)
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
  private deriveSessionStats(events: ReadonlyArray<{ type: string; data: any }>): {
    title: string; turns: number; steps: number; toolCalls: number; inputTokens: number; outputTokens: number
    contextWindow: number; lastInputTokens: number
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

    // Track the latest usage sample for context % display.
    let lastInputTokens = 0

    for (const event of events) {
      if (event.type === 'turn/start') {
        turns.add((event.data?.turn as number | undefined) ?? turns.size)
      } else if (event.type === 'step/start') {
        steps++
      } else if (event.type === 'tool/call') {
        toolCalls++
      } else if (event.type === 'assistant/message' || (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage')) {
        const turn = event.data?.turn as number | undefined
        const step = event.data?.step as number | undefined
        // For assistant/message, usage is at data.usage; for assistant/chunk, at data.chunk.usage
        const usage = event.type === 'assistant/message'
          ? event.data?.usage
          : event.data?.chunk?.usage
        if (usage === undefined || usage === null) continue
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

    return { title, turns: turns.size, steps, toolCalls, inputTokens, outputTokens: totalOutput, contextWindow, lastInputTokens }
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
    const sessionId = this.resolveSessionId(this.messageFromKey(key))
    const liveAgent = this.deps.agents.get(sessionId as never)
    if (liveAgent !== undefined) {
      // Reuse the live agent. The original setup path only ran `installModelSelection`
      // when we created this session; a restart that loses the bridge's `selections`
      // cache leaves the live agent with no dsh-feishu-side ref to mutate. Re-attach a
      // fresh ref to the live agent's ctx so subsequent `/model` commands can flip
      // `ref.current` and have the next `system-prompt/assemble` pick it up.
      const existing = this.selections.get(sessionId)
      if (existing === undefined) {
        const fallback = this.deps.selection()
        const initial = {
          provider: this.config.provider ?? fallback.provider,
          model: this.config.model ?? fallback.model,
          ...(fallback.reasoningEffort !== undefined ? { reasoningEffort: fallback.reasoningEffort } : {}),
        } satisfies ModelSelection
        const ref: LiveSelection = { current: initial, assembled: undefined }
        installModelSelection(liveAgent.ctx, ref)
        this.selections.set(sessionId, ref)
      }
      return { agent: liveAgent as unknown as AgentLike, dispose: async () => undefined }
    }
    const fallback = this.deps.selection()
    const initial = {
      provider: this.config.provider ?? fallback.provider,
      model: this.config.model ?? fallback.model,
      ...(fallback.reasoningEffort !== undefined ? { reasoningEffort: fallback.reasoningEffort } : {}),
    } satisfies ModelSelection
    // Build a mutable ref once per session; the agent loop's `installModelSelection`
    // listener reads `current` on every `system-prompt/assemble`, so a later
    // `/model` command mutating `ref.current` takes effect on the next message.
    const selection: LiveSelection = { current: initial, assembled: undefined }
    this.selections.set(sessionId, selection)
    const workspace = this.config.workspace === undefined
      ? this.deps.workspaceRegistry.list()[0]
      : await this.deps.workspaceRegistry.resolveByPath(this.config.workspace)
    // Use the workspace's actual path as cwd to ensure consistency
    // When no workspace is configured, use the first workspace's path
    const cwd = workspace?.path ?? this.config.workspace ?? process.cwd()
    const agentPreset = (await this.deps.agentPresets.resolve(this.config.agentPreset)).id
    const setup = async (agentCtx: Parameters<typeof installModelSelection>[0]) => {
      installModelSelection(agentCtx, selection)
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
