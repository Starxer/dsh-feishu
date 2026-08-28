import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { DomainName } from './config.ts'

export interface ConversationMessage {
  chatId: string
  chatType: 'p2p' | 'group'
  threadId?: string
  /** Topic root message id — the correct `replyTo` target when replying into a Feishu topic. */
  rootId?: string
  replyToMessageId?: string
}

export function conversationKey(message: ConversationMessage): string {
  return message.threadId === undefined
    ? `chat:${message.chatId}`
    : `thread:${message.chatId}:${message.threadId}`
}

export function toSessionId(domain: DomainName, key: string): SessionId {
  const digest = createHash('sha256').update(`${domain}\0${key}`).digest('hex').slice(0, 40)
  // v2 sessions include the Harness workspace and agent-preset composition.
  // Keep them separate from sessions created by releases that lacked it.
  return SessionId(`lark-v2-${digest}`)
}

interface EventLike {
  seq: number
  type: string
  data: any
}

export interface TurnSummary { text: string; ok: boolean }

export function summarizeTurn(events: readonly EventLike[], firstSeq: number): TurnSummary {
  let text = ''
  let completed = false
  let failed = false
  let hasAssistantMessage = false
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      hasAssistantMessage = true
      const message = event.data?.message
      if (message !== undefined && message !== null) {
        const content = message.content
        if (Array.isArray(content)) {
          const next = content
            .filter((block: any) => block.type === 'text' && typeof block.text === 'string')
            .map((block: any) => block.text)
            .join('')
          if (next !== '') text = next
        }
      }
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason
      if (reason !== undefined && reason !== null) {
        completed = reason.kind === 'completed'
        failed = reason.kind === 'error' || reason.kind === 'cancelled'
      }
    }
  }
  if (completed && !failed && text === '' && hasAssistantMessage) {
    return { text: '(no text response)', ok: true }
  }
  return { text, ok: completed && !failed && text !== '' }
}
