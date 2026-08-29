import { describe, expect, it, vi } from 'vitest'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
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
  /** Resolved answers captured from listener return values. */
  answered: Array<{ sessionId: string; answer: AskUserQuestionAnswer }>
  sentCards: Array<{ to: string; card: { schema?: string; header?: { title?: { content?: string } }; body?: { elements?: unknown[] }; elements?: unknown[] } }>
  cardActionHandler: ((evt: unknown) => void | Promise<void>) | undefined
  resolveChatCalls: string[]
}

interface CtxHandle {
  ctx: Parameters<typeof startFeishuQuestions>[0]['ctx']
  /** Fire one user-questions request through the registered waterfall. */
  trigger: (sessionId: string, questions: AskUserQuestionItem[], agent?: { session: { id: string } }) => Promise<AskUserQuestionAnswer | undefined>
}

/**
 * Build a fake Context that records the `user-questions/request` listener
 * the plugin registers, and exposes a `trigger()` helper that invokes the
 * listener with a synthetic request. The listener's return value (or
 * undefined when it calls `next()`) is the resolved answer.
 */
function buildCtx(): CtxHandle {
  const listeners: Array<(request: AskUserQuestionRequest, next?: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer | undefined>> = []
  const ctx = {
    on: (_event: string, listener: (request: AskUserQuestionRequest, next?: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer | undefined>) => {
      if (_event === 'user-questions/request') listeners.push(listener)
      return () => {
        const idx = listeners.indexOf(listener)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
  } as unknown as Parameters<typeof startFeishuQuestions>[0]['ctx']

  return {
    ctx,
    trigger: async (sessionId, questions, agent) => {
      const listener = listeners[0]
      if (listener === undefined) return undefined
      const request: AskUserQuestionRequest = {
        questions,
        ...(agent !== undefined ? { agent: { session: { id: sessionId } } as never } : {}),
      }
      const result = await listener(request, async () => {
        throw new Error('no fallback answerer in test')
      })
      return result
    },
  }
}

interface ChannelHandle {
  channel: Parameters<typeof startFeishuQuestions>[0]['channel']
  cleanup: () => void
}

function buildChannel(harness: Harness): ChannelHandle {
  const cardUnsubFns: Array<() => void> = []
  const channel = {
    send: vi.fn(async (to: string, input: { card?: object; text?: string }) => {
      if (input.card !== undefined) {
        harness.sentCards.push({ to, card: input.card as Harness['sentCards'][0]['card'] })
      }
    }),
    updateCard: vi.fn(async () => {}),
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
    const harness: Harness = { answered: [], sentCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger })
    try {
      // Fire the request; it will suspend waiting for a cardAction.
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.sentCards).toHaveLength(1)
      expect(harness.sentCards[0]!.to).toBe('oc_chat')
      expect(harness.sentCards[0]!.card.body?.elements).toBeDefined()
      // Simulate the user picking an option via cardAction.
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId: extractPendingId(harness.sentCards[0]!.card), questionId: 'q1', selected: ['Yes'] }),
        },
      })
      const answer = await answerPromise
      expect(answer).toEqual({ answers: [{ id: 'q1', selected: ['Yes'] }] })
    } finally {
      stop()
      cleanup()
    }
  })

  it('renders one card per question and accumulates answers sequentially', async () => {
    const harness: Harness = { answered: [], sentCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger })
    const Q2: AskUserQuestionItem = { id: 'q2', question: 'Second?', options: [{ label: 'B' }, { label: 'C' }] }
    try {
      // Fire a two-question request; it suspends awaiting the first card.
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION, Q2], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.sentCards).toHaveLength(1)
      // Answer the first question; the loop must then send the second card.
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId: extractPendingId(harness.sentCards[0]!.card), questionId: 'q1', selected: ['Yes'] }),
        },
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.sentCards).toHaveLength(2)
      // Answer the second question; only now does the batch resolve.
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId: extractPendingId(harness.sentCards[1]!.card), questionId: 'q2', selected: ['B'] }),
        },
      })
      const answer = await answerPromise
      expect(answer).toEqual({ answers: [{ id: 'q1', selected: ['Yes'] }, { id: 'q2', selected: ['B'] }] })
    } finally {
      stop()
      cleanup()
    }
  })

  it('resolves custom answer from form_value', async () => {
    const harness: Harness = { answered: [], sentCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger })
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      expect(harness.sentCards).toHaveLength(1)
      const pendingId = extractPendingId(harness.sentCards[0]!.card)
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId, questionId: 'q1', type: 'custom' }),
        },
        raw: {
          action: {
            value: JSON.stringify({ pendingId, questionId: 'q1', type: 'custom' }),
            form_value: { custom_text: '自定义回答' },
          },
        },
      })
      const answer = await answerPromise
      expect(answer).toEqual({ answers: [{ id: 'q1', selected: [], custom: '自定义回答' }] })
    } finally {
      stop()
      cleanup()
    }
  })

  it('ignores custom submit with empty input', async () => {
    const harness: Harness = { answered: [], sentCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger })
    try {
      const answerPromise = ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
      await new Promise(resolve => setImmediate(resolve))
      const pendingId = extractPendingId(harness.sentCards[0]!.card)
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId, questionId: 'q1', type: 'custom' }),
        },
        raw: {
          action: {
            value: JSON.stringify({ pendingId, questionId: 'q1', type: 'custom' }),
            form_value: { custom_text: '' },
          },
        },
      })
      // The pending request is still outstanding (custom ignored because input empty).
      // Resolving it now so the test doesn't leak a promise.
      const stillPending = await Promise.race([
        answerPromise.then(() => 'done'),
        new Promise<string>(r => setTimeout(() => r('pending'), 20)),
      ])
      expect(stillPending).toBe('pending')
    } finally {
      stop()
      cleanup()
    }
  })

  it('ignores clicks that do not match any pending question', async () => {
    const harness: Harness = { answered: [], sentCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger })
    try {
      await harness.cardActionHandler!({
        action: {
          tag: 'button',
          value: JSON.stringify({ pendingId: 'unknown', questionId: 'q1', selected: ['Yes'] }),
        },
      })
      // No pending question matches; nothing happens.
    } finally {
      stop()
      cleanup()
    }
  })

  it('skips rendering when the question targets a non-Feishu session', async () => {
    const harness: Harness = { answered: [], sentCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => undefined,
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger })
    try {
      // Triggering with no agent means listener calls `next()` and rejects (no fallback).
      await expect(ctxHandle.trigger('webui-only-session', [QUESTION])).rejects.toThrow()
      // No card sent because no Feishu chat owns the session.
      expect(harness.sentCards).toEqual([])
      expect(harness.resolveChatCalls).toEqual([])
    } finally {
      stop()
      cleanup()
    }
  })

  it('clears the cardAction handler on dispose', async () => {
    const harness: Harness = { answered: [], sentCards: [], cardActionHandler: undefined, resolveChatCalls: [] }
    const ctxHandle = buildCtx()
    const { channel, cleanup } = buildChannel(harness)
    const bridgeHolder = buildBridgeHolder(
      () => ({ chatId: 'oc_chat', chatType: 'p2p' as const }),
      harness,
    )
    const stop = startFeishuQuestions({ ctx: ctxHandle.ctx, channel, bridgeHolder, logger })
    void ctxHandle.trigger('oc_session', [QUESTION], { session: { id: 'oc_session' } })
    await new Promise(resolve => setImmediate(resolve))
    stop()
    expect(harness.cardActionHandler).toBeUndefined()
    cleanup()
  })
})

/** Extract the plugin-generated pendingId from a rendered question card. */
function extractPendingId(card: Harness['sentCards'][0]['card']): string {
  // The plugin embeds `pendingId` in each button's `behaviors[*].value` object.
  // Walk the body elements recursively, looking for a `tag: 'button'` whose
  // first behavior has `value.pendingId`.
  const walk = (els: unknown[]): string | undefined => {
    for (const el of els) {
      if (el === null || typeof el !== 'object') continue
      const obj = el as Record<string, unknown>
      if (obj.tag === 'button') {
        const behaviors = obj.behaviors
        if (Array.isArray(behaviors)) {
          for (const b of behaviors) {
            if (b === null || typeof b !== 'object') continue
            const v = (b as Record<string, unknown>).value
            if (v !== null && typeof v === 'object') {
              const pid = (v as Record<string, unknown>).pendingId
              if (typeof pid === 'string') return pid
            }
          }
        }
      }
      // Recurse into form containers, columns, etc.
      if (Array.isArray(obj.elements)) {
        const found = walk(obj.elements as unknown[])
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  const elements = card.body?.elements as unknown[] | undefined
  if (elements === undefined) throw new Error('card has no body.elements')
  const found = walk(elements)
  if (found === undefined) throw new Error('card has no pendingId')
  return found
}
