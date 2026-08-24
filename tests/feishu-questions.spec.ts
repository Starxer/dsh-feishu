import { describe, expect, it, vi } from 'vitest'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { startFeishuQuestions } from '../src/feishu-questions.ts'

const QUESTION: AskUserQuestionItem = {
  id: 'q1',
  question: 'Pick one',
  header: 'Choice',
  options: [
    { label: 'Yes', description: 'approve' },
    { label: 'No', description: 'decline' },
  ],
  multiSelect: false,
}

interface Harness {
  respondCalls: Array<{ rpcId: string; questionId: string; selected: string[]; custom?: string }>
  sentCards: Array<{ to: string; card: { header?: { title?: { content?: string } }; elements?: unknown[] } }>
  cardActionHandler: ((evt: unknown) => void | Promise<void>) | undefined
  resolveChatCalls: string[]
}

interface ApiProxyHandle {
  apiProxy: Parameters<typeof startFeishuQuestions>[0]['apiProxy']
  push: (rpcId: string, sessionId: string, questions: AskUserQuestionItem[]) => void
  respondMock: ReturnType<typeof vi.fn>
}

/**
 * Build a fake apiProxy whose `events.mux()` returns an async iterable we
 * can push frames into. The respond() call is captured by vi.fn.
 */
function buildApiProxy(harness: Harness): ApiProxyHandle {
  const pendingFrames: Array<{ rpcId: ReturnType<typeof RpcId>; payload: unknown }> = []
  const waiters: Array<() => void> = []

  const mux = (async function* () {
    while (true) {
      while (pendingFrames.length > 0) {
        yield pendingFrames.shift() as { rpcId: ReturnType<typeof RpcId>; payload: unknown }
      }
      await new Promise<void>(resolve => { waiters.push(resolve) })
    }
  })()

  const respondMock = vi.fn(async (message: {
    rpcId: ReturnType<typeof RpcId>
    result: {
      ok: true
      value: {
        sessionId: string
        answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> }
      }
    }
  }) => {
    const answer = message.result.value.answer.answers[0]!
    harness.respondCalls.push({
      rpcId: message.rpcId as unknown as string,
      questionId: answer.id,
      selected: [...answer.selected],
      ...answer.custom === undefined ? {} : { custom: answer.custom },
    })
    return { accepted: true }
  })

  const apiProxy = {
    events: { mux: () => mux },
    respond: respondMock,
  } as unknown as Parameters<typeof startFeishuQuestions>[0]['apiProxy']

  return {
    apiProxy,
    push: (rpcId, sessionId, questions) => {
      pendingFrames.push({ rpcId: RpcId(rpcId), payload: { type: 'question/requested', sessionId, questions } })
      const next = waiters.shift()
      if (next !== undefined) next()
    },
    respondMock,
  }
}

interface ChannelHandle {
  channel: Parameters<typeof startFeishuQuestions>[0]['channel']
  cleanup: () => void
}

function buildChannel(harness: Harness): ChannelHandle {
  const cardUnsubFns: Array<() => void> = []
  const channel = {
    send: vi.fn(async (to: string, input: { card: { header?: { title?: { content?: string } }; elements?: unknown[] } }) => {
      harness.sentCards.push({ to, card: input.card })
    }),
    onCardAction: (handler: (evt: unknown) => void | Promise<void>) => {
      harness.cardActionHandler = handler
      const unsub = () => { harness.cardActionHandler = undefined }
      cardUnsubFns.push(unsub)
      return unsub
    },
  } as unknown as Parameters<typeof startFeishuQuestions>[0]['channel']
  return {
    channel,
    cleanup: () => { for (const fn of cardUnsubFns) fn() },
  }
}

function buildBridgeHolder(resolveChat: (sessionId: string) => { chatId: string; chatType: 'p2p' } | undefined, harness: Harness) {
  const bridge = {
    resolveChat: vi.fn((sessionId: string) => {
      harness.resolveChatCalls.push(sessionId)
      return resolveChat(sessionId)
    }),
  }
  return { current: bridge as unknown as Parameters<typeof startFeishuQuestions>[0]['bridgeHolder']['current'] }
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe('startFeishuQuestions', () => {
  it('renders an interactive card and resolves when the user clicks an option', async () => {
    const harness: Harness = { respondCalls: [], sentCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const api = buildApiProxy(harness)
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ apiProxy: api.apiProxy, channel, bridgeHolder, logger })
    try {
      api.push('rpc-1', 'oc_session', [QUESTION])
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.sentCards).toHaveLength(1)
      expect(harness.sentCards[0]!.to).toBe('oc_chat')
      expect(harness.sentCards[0]!.card.elements).toBeDefined()
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ rpcId: 'rpc-1', questionId: 'q1', selected: ['Yes'] }),
        },
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.respondCalls).toEqual([
        { rpcId: 'rpc-1', questionId: 'q1', selected: ['Yes'] },
      ])
    } finally {
      stop()
      cleanup()
    }
  })

  it('ignores clicks that do not match any pending question', async () => {
    const harness: Harness = { respondCalls: [], sentCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const api = buildApiProxy(harness)
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ apiProxy: api.apiProxy, channel, bridgeHolder, logger })
    try {
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ rpcId: 'unknown', questionId: 'q1', selected: ['Yes'] }),
        },
      })
      expect(harness.respondCalls).toEqual([])
    } finally {
      stop()
      cleanup()
    }
  })

  it('skips rendering when the question targets a non-Feishu session', async () => {
    const harness: Harness = { respondCalls: [], sentCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const api = buildApiProxy(harness)
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => undefined,
      harness,
    )
    const stop = startFeishuQuestions({ apiProxy: api.apiProxy, channel, bridgeHolder, logger })
    try {
      api.push('rpc-2', 'webui-only-session', [QUESTION])
      await new Promise(resolve => setImmediate(resolve))
      // No card sent because no Feishu chat owns the session.
      expect(harness.sentCards).toEqual([])
      expect(harness.resolveChatCalls).toEqual(['webui-only-session'])
    } finally {
      stop()
      cleanup()
    }
  })

  it('clears the cardAction handler on dispose', async () => {
    const harness: Harness = { respondCalls: [], sentCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const api = buildApiProxy(harness)
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ apiProxy: api.apiProxy, channel, bridgeHolder, logger })
    api.push('rpc-3', 'oc_session', [QUESTION])
    await new Promise(resolve => setImmediate(resolve))
    stop()
    expect(harness.cardActionHandler).toBeUndefined()
    cleanup()
  })
})
