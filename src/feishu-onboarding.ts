/**
 * Feishu onboarding cards.
 *
 * 1. First-message onboarding: a chat (main chat or topic) that has no
 *    session history gets a card listing every persisted session (occupied
 *    ones carry a lock marker) plus a "create new" action, instead of
 *    silently auto-creating a session. Selecting an occupied session
 *    force-takes it over: the previous owner is released (reset to a fresh
 *    session) and the session is rebound to this chat.
 *
 * 2. `/new` card flow: workspace picker → agent preset picker → model
 *    picker (reusing the model-select cards) → session creation. The
 *    defaults come from the latest active session's settings when
 *    available, falling back to deployment-wide config.
 *
 * @module @starxer/chatterbox4dsh/feishu-onboarding
 */

import type { HarnessConversationService, ChatCreationOptions } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Minimal logger surface. */
interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Source of the current bridge — recreated on every channel reconcile. */
interface BridgeHolder {
  current: HarnessConversationService | undefined
}

/** Subset of the cardAction event the onboarding cards consume. */
interface CardActionLike {
  messageId?: string
  chatId?: string
  operator?: { openId?: string }
  action?: { value?: unknown; tag?: string; option?: string }
  raw?: { action?: { value?: unknown; tag?: string; option?: string; form_value?: Record<string, unknown> } }
}

/** Channel adapter — same surface as feishu-model-select.ts. */
export interface OnboardingChannel {
  send(to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  onCardAction(handler: (evt: CardActionLike) => void | Promise<void>): () => void
  createCardInstance(card: object): Promise<string>
  sendCardByReference(to: string, cardId: string, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCardInstance(cardId: string, card: object, sequence: number): Promise<void>
}

/** Narrow workspace registry view. */
interface WorkspaceLike {
  path: string
  name?: string
}

/** Workspace registry surface the onboarding flow needs: list existing
 *  workspaces and create new ones by path. */
interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
  create(path: string, title?: string): Promise<unknown>
}

/** Narrow agentPresets view. */
interface AgentPresetsLike {
  list(): Promise<Array<{ id: string; title?: string }>>
  defaultId: string
}

/** Narrow agentDefaultModel view. */
interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

/** Deployment-wide config fallbacks for the `/new` flow. */
export interface OnboardingConfig {
  workspace: string | undefined
  agentPreset: string | undefined
  provider: string | undefined
  model: string | undefined
}

export interface FeishuOnboardingDeps {
  bridgeHolder: BridgeHolder
  channel: OnboardingChannel
  logger: PluginLogger
  workspaceRegistry: WorkspaceRegistryLike
  agentPresets: AgentPresetsLike
  agentDefaultModel: AgentDefaultModelLike
  config: OnboardingConfig
  /** Return the strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
  /** Advance the `/new` flow to the model step. The caller renders the
   *  model-select provider card (reusing feishu-model-select with flow
   *  `new-session`); the model-select handle's onNewSessionConfirm callback
   *  then commits the selection to session creation. */
  onModelStep: (chatMessage: ConversationMessage, messageId: string | undefined, flowState: { workspace?: string; agentPreset?: string }) => Promise<void>
}

/** A queued onboarding card action. */
interface QueuedAction {
  kind: 'attach' | 'new' | 'pick-workspace' | 'pick-preset' | 'create-workspace' | 'cancel'
  chatMessage: ConversationMessage
  messageId: string | undefined
  sessionId?: string
  value?: string
}

/** Parse the onboarding card action value (same JSON unwrap as model-select). */
function parseOnboardingAction(evt: CardActionLike): QueuedAction | undefined {
  // --- Form submission: attach form (session dropdown) / workspace form ---
  const formValue = evt.raw?.action?.form_value
  if (formValue !== undefined) {
    const raw = evt.action?.value
    let valueObj: Record<string, unknown> | undefined
    if (typeof raw === 'string') {
      try {
        let result: unknown = JSON.parse(raw)
        let depth = 0
        while (typeof result === 'string' && depth < 4) {
          try { result = JSON.parse(result) } catch { break }
          depth++
        }
        if (typeof result === 'object' && result !== null) valueObj = result as Record<string, unknown>
      } catch { /* not JSON */ }
    } else if (typeof raw === 'object' && raw !== null) {
      valueObj = raw as Record<string, unknown>
    }
    const kind = valueObj !== undefined && typeof valueObj.kind === 'string' ? valueObj.kind : undefined
    const chatId = evt.chatId
    if (chatId === undefined) return undefined
    const chatMessage: ConversationMessage = { chatId, chatType: 'p2p' }
    if (kind === 'attach') {
      const sessionId = typeof formValue.session === 'string' && formValue.session !== '' ? formValue.session : undefined
      if (sessionId !== undefined) return { kind: 'attach', chatMessage, messageId: evt.messageId, sessionId }
      return undefined
    }
    if (kind === 'create-workspace') {
      const path = typeof formValue.workspace_path === 'string' && formValue.workspace_path.trim() !== ''
        ? formValue.workspace_path.trim()
        : undefined
      if (path !== undefined) return { kind: 'create-workspace', chatMessage, messageId: evt.messageId, value: path }
      return undefined
    }
    return undefined
  }

  const raw = evt.action?.value
  let valueObj: Record<string, unknown> | undefined
  if (typeof raw === 'string') {
    try {
      let result: unknown = JSON.parse(raw)
      let depth = 0
      while (typeof result === 'string' && depth < 4) {
        try { result = JSON.parse(result) } catch { break }
        depth++
      }
      if (typeof result === 'object' && result !== null) valueObj = result as Record<string, unknown>
    } catch { /* not JSON */ }
  } else if (typeof raw === 'object' && raw !== null) {
    valueObj = raw as Record<string, unknown>
  }
  if (valueObj === undefined) return undefined
  const kind = typeof valueObj.kind === 'string' ? valueObj.kind : undefined
  const sessionId = typeof valueObj.sessionId === 'string' ? valueObj.sessionId : undefined
  const value = typeof valueObj.value === 'string' ? valueObj.value : undefined
  const chatId = evt.chatId
  if (chatId === undefined) return undefined
  const chatMessage: ConversationMessage = { chatId, chatType: 'p2p' }
  if (kind === 'attach' && sessionId !== undefined) return { kind: 'attach', chatMessage, messageId: evt.messageId, sessionId }
  if (kind === 'new') return { kind: 'new', chatMessage, messageId: evt.messageId }
  if (kind === 'pick-workspace' && value !== undefined) return { kind: 'pick-workspace', chatMessage, messageId: evt.messageId, value }
  if (kind === 'pick-preset' && value !== undefined) return { kind: 'pick-preset', chatMessage, messageId: evt.messageId, value }
  if (kind === 'cancel') return { kind: 'cancel', chatMessage, messageId: evt.messageId }
  return undefined
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

/** First-message onboarding card: attach a persisted session or create new. */
function renderOnboardingCard(
  sessions: Array<{ id: string; title: string; ownedBy?: string }>,
  describeChatKey: (key: string) => string,
  threadLabel: string,
  t: Translations,
): object {
  const sessionOptions = sessions.map((session, index) => {
    const title = session.title === '' ? t.onboardingSessionFallback(index + 1, session.id.slice(-12)) : session.title.replace(/\s+/g, ' ').slice(0, 40)
    const lock = session.ownedBy === undefined ? '' : t.onboardingInUse(describeChatKey(session.ownedBy))
    return {
      text: { tag: 'plain_text', content: `📎 ${title}${lock}` },
      value: session.id,
    }
  })
  const formElements: object[] = []
  if (sessions.length === 0) {
    formElements.push({
      tag: 'markdown',
      content: t.onboardingNoSessions,
    })
  } else {
    formElements.push(
      { tag: 'markdown', content: t.onboardingPickExisting },
      {
        tag: 'select_static',
        name: 'session',
        placeholder: { tag: 'plain_text', content: t.onboardingSelectPlaceholder },
        options: sessionOptions,
        value: sessions[0]!.id,
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t.onboardingAttachButton },
        type: 'primary',
        name: 'attach',
        form_action_type: 'submit',
        behaviors: [{ type: 'callback', value: { kind: 'attach' } }],
      },
    )
  }
  formElements.push({ tag: 'hr' })
  formElements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t.onboardingNewButton },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { kind: 'new' } }],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.onboardingAttachTitle },
      template: 'turquoise',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: t.onboardingIntro(threadLabel),
        },
        { tag: 'hr' },
        { tag: 'form', name: 'onboarding_attach_form', elements: formElements },
      ],
    },
  }
}

/** Workspace picker card (step 1 of /new): choose an existing workspace or
 *  create a new one by absolute path or a `~`-relative path. */
function renderWorkspacePicker(workspaces: readonly WorkspaceLike[], currentWorkspace: string | undefined, t: Translations): object {
  const elements: object[] = [
    { tag: 'markdown', content: t.onboardingWorkspaceHeader },
    { tag: 'hr' },
  ]
  if (workspaces.length === 0) {
    elements.push({ tag: 'markdown', content: t.onboardingNoWorkspaces })
  }
  for (const ws of workspaces) {
    const label = ws.name !== undefined && ws.name !== '' ? ws.name : ws.path
    const mark = ws.path === currentWorkspace ? ' ✅' : ''
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `📁 ${label}${mark}` },
      type: ws.path === currentWorkspace ? 'primary' : 'default',
      behaviors: [{ type: 'callback', value: { kind: 'pick-workspace', value: ws.path } }],
    })
  }
  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'markdown',
    content: t.onboardingNewWorkspaceHeader,
  })
  elements.push({
    tag: 'form',
    name: 'onboarding_workspace_form',
    elements: [
      {
        tag: 'input',
        name: 'workspace_path',
        placeholder: { tag: 'plain_text', content: t.onboardingWorkspacePlaceholder },
        value: { tag: 'plain_text', content: '' },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t.onboardingCreateWorkspaceButton },
        type: 'primary',
        name: 'create_ws',
        form_action_type: 'submit',
        behaviors: [{ type: 'callback', value: { kind: 'create-workspace' } }],
      },
    ],
  })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: `← ${t.cancel}` },
    type: 'default',
    behaviors: [{ type: 'callback', value: { kind: 'cancel' } }],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.onboardingNewTitle },
      template: 'blue',
    },
    body: { elements },
  }
}

/** Agent preset picker card (step 2 of /new). */
function renderPresetPicker(presets: readonly { id: string; name?: string }[], currentPreset: string | undefined, t: Translations): object {
  const elements: object[] = [
    { tag: 'markdown', content: t.onboardingPresetHeader },
    { tag: 'hr' },
  ]
  if (presets.length === 0) {
    elements.push({ tag: 'markdown', content: t.onboardingNoPresets })
  }
  for (const preset of presets) {
    const label = preset.name !== undefined && preset.name !== '' ? preset.name : preset.id
    const mark = preset.id === currentPreset ? ' ✅' : ''
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `🧩 ${label}${mark}` },
      type: preset.id === currentPreset ? 'primary' : 'default',
      behaviors: [{ type: 'callback', value: { kind: 'pick-preset', value: preset.id } }],
    })
  }
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: `← ${t.cancel}` },
    type: 'default',
    behaviors: [{ type: 'callback', value: { kind: 'cancel' } }],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.onboardingNewTitle },
      template: 'blue',
    },
    body: { elements },
  }
}

/** Session-created success card. */
function renderCreatedCard(sessionId: string, summary: string, t: Translations): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.onboardingCreatedTitle },
      template: 'green',
    },
    body: {
      elements: [
        { tag: 'markdown', content: t.onboardingCreatedBody(sessionId, summary) },
      ],
    },
  }
}

/** Attach success card. */
function renderAttachedCard(sessionId: string, ownerLabel: string | undefined, t: Translations): object {
  const takeover = ownerLabel === undefined ? '' : t.onboardingTakeover(ownerLabel)
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.onboardingAttachedTitle },
      template: 'green',
    },
    body: {
      elements: [
        { tag: 'markdown', content: t.onboardingAttachedBody(sessionId, takeover) },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface FeishuOnboardingHandle {
  dispose(): void
  /** Send the first-message onboarding card (attach or create). */
  sendOnboardingCard(chatMessage: ConversationMessage, threadLabel: string): Promise<void>
  /** Start the `/new` card flow: workspace → preset → model → create. */
  startNewFlow(chatMessage: ConversationMessage): Promise<void>
  /** The workspace/preset captured so far by this chat's `/new` flow. */
  creationOptionsFor(chatId: string): { workspace?: string; agentPreset?: string }
  /** Topic reply context recorded for a chat (rootId/threadId), so the
   *  model-step card sent by the caller lands in the same topic. */
  topicFor(chatId: string): { rootId?: string; threadId?: string }
  /** Record topic context from an inbound message (e.g. a slash command in a
   *  topic) so later card actions from that chat recover their thread key. */
  noteTopic(chatMessage: ConversationMessage): void
}

export function startFeishuOnboarding(deps: FeishuOnboardingDeps): FeishuOnboardingHandle {
  const { bridgeHolder, channel, logger, workspaceRegistry, agentPresets, agentDefaultModel, config, getTranslations, onModelStep } = deps

  const cardByMessage = new Map<string, string>()
  const sequenceByCard = new Map<string, number>()

  /** Per-chat in-flight `/new` flow state. */
  const newFlow = new Map<string, { workspace?: string; agentPreset?: string }>()
  /** Topic reply context per chat, so cards sent from button callbacks land
   *  in the same Feishu topic the user clicked from. Keyed by chatId. */
  const chatTopic = new Map<string, { rootId?: string; threadId?: string }>()

  /** Send opts that land in the chat's topic when it has one. */
  function topicOpts(chatMessage: ConversationMessage): { replyInThread?: boolean; replyTo?: string } {
    const rootId = chatMessage.rootId ?? chatTopic.get(chatMessage.chatId)?.rootId
    const threadId = chatMessage.threadId ?? chatTopic.get(chatMessage.chatId)?.threadId
    if (threadId === undefined || rootId === undefined) return {}
    return { replyInThread: true, replyTo: rootId }
  }

  /** Record topic context from an inbound chat message (first message or
   *  slash command) so later card callbacks keep replying in-topic. */
  function recordTopic(chatMessage: ConversationMessage): void {
    if (chatMessage.threadId === undefined) return
    chatTopic.set(chatMessage.chatId, {
      ...(chatMessage.rootId !== undefined ? { rootId: chatMessage.rootId } : {}),
      threadId: chatMessage.threadId,
    })
  }

  async function sendCard(
    chatMessage: ConversationMessage,
    card: object,
    messageId: string | undefined,
  ): Promise<void> {
    const opts = topicOpts(chatMessage)
    if (messageId === undefined) {
      const cardId = await channel.createCardInstance(card)
      const result = await channel.sendCardByReference(chatMessage.chatId, cardId, opts)
      const sentId = result.messageId ?? ''
      if (sentId !== '') {
        cardByMessage.set(sentId, cardId)
        sequenceByCard.set(cardId, 0)
      }
      return
    }
    const cardId = cardByMessage.get(messageId)
    if (cardId === undefined) {
      const fresh = await channel.createCardInstance(card)
      const result = await channel.sendCardByReference(chatMessage.chatId, fresh, opts)
      const sentId = result.messageId ?? ''
      if (sentId !== '') {
        cardByMessage.set(sentId, fresh)
        sequenceByCard.set(fresh, 0)
      }
      return
    }
    const seq = (sequenceByCard.get(cardId) ?? 0) + 1
    sequenceByCard.set(cardId, seq)
    try {
      await channel.updateCardInstance(cardId, card, seq)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: onboarding updateCardInstance failed: ${msg} — sending fresh card`)
      const cardId2 = await channel.createCardInstance(card)
      const result = await channel.sendCardByReference(chatMessage.chatId, cardId2, opts)
      const sentId = result.messageId ?? ''
      if (sentId !== '') {
        cardByMessage.set(sentId, cardId2)
        sequenceByCard.set(cardId2, 0)
      }
    }
  }

  /** Build the workspace picker with the default = deployment config. */
  async function buildWorkspacePicker(_chatMessage: ConversationMessage): Promise<object> {
    return renderWorkspacePicker(workspaceRegistry.list(), config.workspace, getTranslations())
  }

  async function handleAttach(action: QueuedAction): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    const sessionId = action.sessionId!
    const result = bridge.attachSession(action.chatMessage, sessionId)
    if (result === 'archived') {
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: getTranslations().onboardingAttachArchivedTitle }, template: 'red' },
        body: { elements: [{ tag: 'markdown', content: getTranslations().onboardingAttachArchivedBody }] },
      }
      await sendCard(action.chatMessage, card, action.messageId)
      return
    }
    const ownerKey = bridge.sessionOwnerKey(sessionId)
    const ownerLabel = ownerKey === undefined ? undefined : bridge.describeChatKey(ownerKey)
    const card = renderAttachedCard(sessionId, ownerLabel, getTranslations())
    await sendCard(action.chatMessage, card, action.messageId)
  }

  async function handleNew(action: QueuedAction): Promise<void> {
    const card = await buildWorkspacePicker(action.chatMessage)
    await sendCard(action.chatMessage, card, action.messageId)
  }

  async function handlePickWorkspace(action: QueuedAction): Promise<void> {
    const chatKey = action.chatMessage.chatId
    const flowState = newFlow.get(chatKey) ?? {}
    if (action.value !== undefined) flowState.workspace = action.value
    newFlow.set(chatKey, flowState)
    const presets = await agentPresets.list()
    const defaultPreset = flowState.agentPreset ?? agentPresets.defaultId
    const card = renderPresetPicker(presets, defaultPreset, getTranslations())
    await sendCard(action.chatMessage, card, action.messageId)
  }

  async function handlePickPreset(action: QueuedAction): Promise<void> {
    const chatKey = action.chatMessage.chatId
    const flowState = newFlow.get(chatKey) ?? {}
    if (action.value !== undefined) flowState.agentPreset = action.value
    newFlow.set(chatKey, flowState)
    await onModelStep(action.chatMessage, action.messageId, flowState)
  }

  /** Expand `~`-relative paths to absolute against the user's home dir. */
  function expandHomePath(input: string): string {
    const trimmed = input.trim()
    if (trimmed === '~') return homedir()
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
      return join(homedir(), trimmed.slice(2))
    }
    return trimmed
  }

  async function handleCreateWorkspace(action: QueuedAction): Promise<void> {
    const chatKey = action.chatMessage.chatId
    const rawPath = action.value ?? ''
    const path = expandHomePath(rawPath)
    try {
      await workspaceRegistry.create(path)
      logger.info(`dsh-feishu: created workspace ${path}`)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: getTranslations().onboardingCreateWorkspaceFailTitle }, template: 'red' },
        body: { elements: [{ tag: 'markdown', content: getTranslations().onboardingCreateWorkspaceFailBody(path, msg) }] },
      }
      await sendCard(action.chatMessage, card, action.messageId)
      return
    }
    // Created — record it as the flow's workspace and continue to preset picker.
    const flowState = newFlow.get(chatKey) ?? {}
    flowState.workspace = path
    newFlow.set(chatKey, flowState)
    const presets = await agentPresets.list()
    const card = renderPresetPicker(presets, flowState.agentPreset ?? agentPresets.defaultId, getTranslations())
    await sendCard(action.chatMessage, card, action.messageId)
  }

  async function handleCancel(action: QueuedAction): Promise<void> {
    newFlow.delete(action.chatMessage.chatId)
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: getTranslations().onboardingCancelTitle }, template: 'grey' },
      body: { elements: [{ tag: 'markdown', content: getTranslations().onboardingCancelledBody }] },
    }
    await sendCard(action.chatMessage, card, action.messageId)
  }

  /** Card action events carry only chatId + messageId — never the thread id.
   *  Restore the topic context recorded when the card was sent so binding and
   *  flow cards target the topic's key (`thread:<chatId>:<threadId>`) instead
   *  of the main chat key (`chat:<chatId>`). */
  function withTopicContext(action: QueuedAction): QueuedAction {
    const ctx = chatTopic.get(action.chatMessage.chatId)
    if (ctx?.threadId === undefined || action.chatMessage.threadId !== undefined) return action
    return {
      ...action,
      chatMessage: {
        ...action.chatMessage,
        threadId: ctx.threadId,
        ...(ctx.rootId !== undefined ? { rootId: ctx.rootId } : {}),
      },
    }
  }

  const onCardAction = async (evt: CardActionLike): Promise<void> => {
    const parsed = parseOnboardingAction(evt)
    if (parsed === undefined) return
    const action = withTopicContext(parsed)
    try {
      switch (action.kind) {
        case 'attach':
          await handleAttach(action)
          break
        case 'new':
          await handleNew(action)
          break
        case 'pick-workspace':
          await handlePickWorkspace(action)
          break
        case 'pick-preset':
          await handlePickPreset(action)
          break
        case 'create-workspace':
          await handleCreateWorkspace(action)
          break
        case 'cancel':
          await handleCancel(action)
          break
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error(`dsh-feishu: onboarding action failed: ${msg}`)
    }
  }

  const unsubscribe = channel.onCardAction(onCardAction)

  return {
    dispose: () => {
      unsubscribe()
      newFlow.clear()
      cardByMessage.clear()
      sequenceByCard.clear()
      chatTopic.clear()
    },
    sendOnboardingCard: async (chatMessage: ConversationMessage, threadLabel: string): Promise<void> => {
      const bridge = bridgeHolder.current
      if (bridge === undefined) return
      recordTopic(chatMessage)
      const sessions = await bridge.listSessions()
      const card = renderOnboardingCard(sessions, key => bridge.describeChatKey(key), threadLabel, getTranslations())
      await sendCard(chatMessage, card, undefined)
    },
    startNewFlow: async (chatMessage: ConversationMessage): Promise<void> => {
      recordTopic(chatMessage)
      const card = await buildWorkspacePicker(chatMessage)
      await sendCard(chatMessage, card, undefined)
    },
    creationOptionsFor: (chatId: string): { workspace?: string; agentPreset?: string } => {
      return newFlow.get(chatId) ?? {}
    },
    topicFor: (chatId: string): { rootId?: string; threadId?: string } => {
      return chatTopic.get(chatId) ?? {}
    },
    noteTopic: (chatMessage: ConversationMessage): void => {
      recordTopic(chatMessage)
    },
  }
}
