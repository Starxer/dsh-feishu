import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { conversationKey, summarizeTurn, toSessionId } from './conversation.ts'
import type { ConversationMessage } from './conversation.ts'
import type { DomainName } from './config.ts'

/** Minimum surface of {@link Agent} the conversation service depends on. */
interface AgentLike {
  session: { id: unknown; seq: number; events: readonly { seq: number; type: string; data: any }[] }
  whenIdle(): Promise<void>
  followup(message: ReturnType<typeof createUserMessage>): void
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
  selection(): { provider: string; model: string }
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

  constructor(private readonly deps: HarnessDependencies, private readonly config: HarnessBridgeConfig) {}

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
      throw new Error('dsh-lark: cannot submit an empty user turn')
    }
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }> = []
    if (hasText) content.push({ type: 'text', text })
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
      // cache leaves the live agent with no dsh-lark-side ref to mutate. Re-attach a
      // fresh ref to the live agent's ctx so subsequent `/model` commands can flip
      // `ref.current` and have the next `system-prompt/assemble` pick it up.
      const existing = this.selections.get(sessionId)
      if (existing === undefined) {
        const fallback = this.deps.selection()
        const initial: ModelSelection = {
          provider: this.config.provider ?? fallback.provider,
          model: this.config.model ?? fallback.model,
        }
        const ref: LiveSelection = { current: initial, assembled: undefined }
        installModelSelection(liveAgent.ctx, ref)
        this.selections.set(sessionId, ref)
      }
      return { agent: liveAgent as unknown as AgentLike, dispose: async () => undefined }
    }
    const fallback = this.deps.selection()
    const initial: ModelSelection = {
      provider: this.config.provider ?? fallback.provider,
      model: this.config.model ?? fallback.model,
    }
    // Build a mutable ref once per session; the agent loop's `installModelSelection`
    // listener reads `current` on every `system-prompt/assemble`, so a later
    // `/model` command mutating `ref.current` takes effect on the next message.
    const selection: LiveSelection = { current: initial, assembled: undefined }
    this.selections.set(sessionId, selection)
    const workspace = this.config.workspace === undefined
      ? this.deps.workspaceRegistry.list()[0]
      : await this.deps.workspaceRegistry.resolveByPath(this.config.workspace)
    const cwd = this.config.workspace ?? workspace?.path ?? process.cwd()
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
    try {
      await workspace?.attachSession(sessionId)
    } catch (error: unknown) {
      await handle.dispose()
      throw error
    }
    return handle
  }
}
