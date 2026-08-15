import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { conversationKey, summarizeTurn, toSessionId } from './conversation.ts'
import type { ConversationMessage } from './conversation.ts'
import type { DomainName } from './config.ts'

interface AgentLike {
  session: { id: unknown; seq: number; events: readonly any[] }
  whenIdle(): Promise<void>
  followup(message: ReturnType<typeof createUserMessage>): void
}

interface AgentHandleLike { agent: AgentLike; dispose(): Promise<void> }

interface WorkspaceLike {
  path: string
  attachSession(sessionId: unknown): Promise<void>
}

export interface HarnessDependencies {
  agents: { create: (options: any) => Promise<AgentHandleLike> }
  sessions: { flush(session: AgentLike['session']): Promise<unknown> }
  selection(): { provider: string; model: string }
  agentPresets: {
    resolve(id?: string): Promise<{ id: string }>
    mount(agentCtx: Parameters<typeof installModelSelection>[0], id?: string): Promise<unknown>
  }
  workspaceRegistry: {
    list(): WorkspaceLike[]
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  }
}

export interface HarnessBridgeConfig {
  domain: DomainName
  workspace?: string
  agentPreset?: string
  provider?: string
  model?: string
}

export interface InboundMessage extends ConversationMessage { content: string }

export class HarnessConversationService {
  private readonly handles = new Map<string, Promise<AgentHandleLike>>()

  constructor(private readonly deps: HarnessDependencies, private readonly config: HarnessBridgeConfig) {}

  async reply(message: InboundMessage): Promise<string> {
    const key = conversationKey(message)
    const handle = await this.getOrCreate(key)
    const agent = handle.agent
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: message.content }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await this.deps.sessions.flush(agent.session)
    const result = summarizeTurn(agent.session.events, firstSeq)
    if (!result.ok) throw new Error('Harness turn did not produce a successful assistant response')
    return result.text
  }

  async dispose(): Promise<void> {
    const handles = await Promise.allSettled(this.handles.values())
    await Promise.all(handles.flatMap(result => result.status === 'fulfilled' ? [result.value.dispose()] : []))
    this.handles.clear()
  }

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
    const fallback = this.deps.selection()
    const selection = {
      provider: this.config.provider ?? fallback.provider,
      model: this.config.model ?? fallback.model,
    }
    const workspace = this.config.workspace === undefined
      ? this.deps.workspaceRegistry.list()[0]
      : await this.deps.workspaceRegistry.resolveByPath(this.config.workspace)
    const cwd = this.config.workspace ?? workspace?.path ?? process.cwd()
    const agentPreset = (await this.deps.agentPresets.resolve(this.config.agentPreset)).id
    const sessionId = toSessionId(this.config.domain, key)
    const handle = await this.deps.agents.create({
      sessionId,
      meta: { cwd, agentPreset },
      agentOptions: selection,
      setup: async (agentCtx: Parameters<typeof installModelSelection>[0]) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
        await this.deps.agentPresets.mount(agentCtx, agentPreset)
      },
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
