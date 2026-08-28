/**
 * Feishu UI bridge for todo visualization: subscribes to the apiproxy mux
 * stream so the Feishu chat can render a card showing the current todo list
 * whenever it changes.
 *
 * @module @starxer/dsh-feishu/feishu-todos
 */

import type { ApiProxy, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { HarnessConversationService } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'

/** Minimal logger surface. */
interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Source of the current bridge. */
interface BridgeHolder {
  current: HarnessConversationService | undefined
}

/** Channel adapter for sending cards. */
export interface FeishuTodosChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<unknown>
}

/** Public deps for the todos module. */
export interface FeishuTodosDeps {
  apiProxy: ApiProxy
  channel: FeishuTodosChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
}

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Per-session todo state for debounced updates. */
interface SessionTodoState {
  /** Last known todos for this session. */
  lastTodos: TodoItem[]
  /** Debounce timer. */
  debounceTimer: ReturnType<typeof setTimeout> | undefined
  /** Last chat coordinates. */
  chat: ConversationMessage | undefined
}

/**
 * Subscribe to the apiproxy mux stream and render todo status cards.
 * Returns a disposer.
 */
export function startFeishuTodos(deps: FeishuTodosDeps): () => void {
  const { apiProxy, channel, bridgeHolder, logger } = deps
  const controller = new AbortController()
  const sessionStates = new Map<string, SessionTodoState>()

  const getState = (sessionId: string): SessionTodoState => {
    let state = sessionStates.get(sessionId)
    if (state === undefined) {
      state = { lastTodos: [], debounceTimer: undefined, chat: undefined }
      sessionStates.set(sessionId, state)
    }
    return state
  }

  const sendTodoCard = (state: SessionTodoState): void => {
    if (state.debounceTimer !== undefined) {
      clearTimeout(state.debounceTimer)
      state.debounceTimer = undefined
    }
    const chat = state.chat
    if (chat === undefined) return
    const todos = state.lastTodos
    if (todos.length === 0) return
    const card = renderTodoCard(todos)
    void channel.send(
      chat.chatId,
      { card },
      chat.threadId !== undefined
        ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
        : {},
    ).catch((error: unknown) => {
      logger.warn(`dsh-feishu: todo card send failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const scheduleTodoCard = (state: SessionTodoState, chat: ConversationMessage, todos: TodoItem[]): void => {
    state.chat = chat
    state.lastTodos = todos
    if (state.debounceTimer !== undefined) {
      clearTimeout(state.debounceTimer)
    }
    state.debounceTimer = setTimeout(() => sendTodoCard(state), 500)
  }

  const iterate = async (): Promise<void> => {
    try {
      for await (const envelope of apiProxy.events.mux(
        { rpcId: RpcId(`feishu-todos-${Date.now()}`), payload: {} },
        controller.signal,
      )) {
        const frame = envelope.payload as MuxFrame
        if (frame.type !== 'session/event') continue
        const event = frame.event
        if (event === undefined) continue
        if (event.type !== 'todo/write') continue
        const bridge = bridgeHolder.current
        if (bridge === undefined) continue
        const chat = bridge.resolveChat(frame.sessionId)
        if (chat === undefined) continue
        const state = getState(frame.sessionId)
        const todos = parseTodos(event.data?.todos)
        if (todos.length === 0) continue
        scheduleTodoCard(state, chat, todos)
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      logger.warn(`dsh-feishu: todo stream interrupted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void iterate()

  return () => {
    controller.abort()
    for (const state of sessionStates.values()) {
      if (state.debounceTimer !== undefined) clearTimeout(state.debounceTimer)
    }
    sessionStates.clear()
  }
}

/**
 * Parse todo items from the event data.
 */
function parseTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const items: TodoItem[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const content = typeof obj.content === 'string' ? obj.content : ''
    if (content === '') continue
    const status = obj.status
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    items.push({ content, status })
  }
  return items
}

/**
 * Status icon mapping.
 */
function statusIcon(status: TodoItem['status']): string {
  switch (status) {
    case 'completed': return '✅'
    case 'in_progress': return '🔄'
    case 'pending': return '⬜'
  }
}

/**
 * Render a todo status card.
 */
function renderTodoCard(todos: TodoItem[]): object {
  const completed = todos.filter(t => t.status === 'completed').length
  const total = todos.length
  const lines: string[] = []
  for (const todo of todos) {
    const icon = statusIcon(todo.status)
    const text = todo.status === 'completed' ? `~~${todo.content}~~` : todo.content
    lines.push(`${icon} ${text}`)
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📋 Todo List' },
      template: 'turquoise',
    },
    body: { elements: [{ tag: 'markdown', content: `**Progress:** ${completed}/${total}\n${lines.join('\n')}` }] },
  }
}
