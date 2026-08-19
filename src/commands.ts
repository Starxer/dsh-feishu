import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult, CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { LlmProviderInfo, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by `@deepseek-ai/dsh-commands`; declared here so this file
     *  does not need a runtime import. */
    commands: CommandRuntime
  }
}

interface LlmDirectoryLike {
  listProviders(): readonly LlmProviderInfo[]
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
}

/**
 * Discover every provider/model route so the user can pick one in chat.
 * Returns a sorted list of `provider/model` strings plus the human-readable
 * catalog used to render the response.
 */
async function buildModelCatalog(
  llm: LlmDirectoryLike,
  t: Pick<CommandTranslations, 'modelListHeader' | 'modelListEmpty'>,
): Promise<string> {
  const providers = llm.listProviders()
  if (providers.length === 0) {
    return t.modelListEmpty
  }
  const lines: string[] = [t.modelListHeader]
  for (const provider of providers) {
    let models: readonly LlmModelInfo[]
    try {
      models = await llm.listModels(provider.id)
    } catch {
      models = []
    }
    if (models.length === 0) {
      lines.push(`• \`${provider.id}\` (no models available)`)
      continue
    }
    for (const model of models) {
      lines.push(`• \`${provider.id}/${model.id}\``)
    }
  }
  return lines.join('\n')
}

export interface CommandTranslations {
  readonly modelDescription: string
  readonly modelCurrentHeader: string
  readonly modelUsage: string
  readonly modelListHeader: string
  readonly modelListEmpty: string
  readonly modelSwitched: (provider: string, model: string) => string
  readonly modelUnknown: (route: string) => string
  readonly compactDescription: string
  readonly compactUsage: string
  readonly compactNoHistory: string
  readonly compactSucceeded: (count: number, tokens: number) => string
  readonly compactBusy: string
  readonly compactCancelled: string
  readonly compactChanged: string
}

/** Parse `provider/model` or `provider/model:reasoning-effort` from the raw input. */
function parseModelRoute(rawInput: string): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const trimmed = rawInput.trim()
  if (trimmed === '') return undefined
  const segments = trimmed.split('/')
  if (segments.length !== 2) return undefined
  const provider = segments[0]?.trim() ?? ''
  const modelSegment = segments[1]?.trim() ?? ''
  if (provider === '' || modelSegment === '') return undefined
  const modelParts = modelSegment.split(':')
  const model = modelParts[0]?.trim() ?? ''
  const reasoningEffort = modelParts[1]?.trim()
  if (model === '') return undefined
  return reasoningEffort === undefined || reasoningEffort === ''
    ? { provider, model }
    : { provider, model, reasoningEffort }
}

/**
 * Build and register the `/model` and `/compact` commands.
 *
 * `/model` either reports the current selection, lists every configured
 * provider/model route, or switches the default selection when invoked with a
 * `provider/model[:reasoning]` argument. `/compact` forwards to
 * `ctx.compaction.compactNow()` and reports the compacted span.
 */
export function registerLarkCommands(
  ctx: Context,
  llm: LlmDirectoryLike,
  agentDefaultModel: AgentDefaultModelConfig,
  t: CommandTranslations,
): void {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'model',
      description: t.modelDescription,
      handler: invocation => handleModelCommand(invocation, llm, agentDefaultModel, t),
    })
  }, 'dsh-lark: /model command')
}

async function handleModelCommand(
  invocation: CommandInvocation,
  llm: LlmDirectoryLike,
  agentDefaultModel: AgentDefaultModelConfig,
  t: CommandTranslations,
): Promise<CommandResult> {
  const rawInput = invocation.rawInput.trim()
  if (rawInput === 'list') {
    const list = await buildModelCatalog(llm, t)
    return { kind: 'success', text: list }
  }
  const route = parseModelRoute(rawInput)
  if (rawInput !== '' && route === undefined) {
    return { kind: 'error', text: `${t.modelUnknown(rawInput)}\n${t.modelUsage}` }
  }
  const current = agentDefaultModel.currentSelection()
  if (route === undefined) {
    return {
      kind: 'success',
      text: `${t.modelCurrentHeader}\n• \`${current.provider}/${current.model}\``,
    }
  }
  const providers = new Set(llm.listProviders().map(provider => provider.id))
  if (!providers.has(route.provider)) {
    return { kind: 'error', text: `${t.modelUnknown(`${route.provider}/${route.model}`)}\n${t.modelUsage}` }
  }
  const selection = {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
  }
  // saveSelection accepts a string-typed reasoning effort; cast at the boundary
  // because the parser does not yet know the target provider's brand type.
  await agentDefaultModel.saveSelection(selection as Parameters<AgentDefaultModelConfig['saveSelection']>[0])
  return { kind: 'success', text: t.modelSwitched(route.provider, route.model) }
}

async function handleCompactCommand(
  invocation: CommandInvocation,
  compaction: CompactionEngine,
  t: CommandTranslations,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: t.compactUsage }
  }
  // Honour an already-aborted signal up front so callers that pre-cancel
  // their dispatch never reach the backend; the catch below still handles
  // mid-flight aborts.
  if (invocation.signal.aborted) return { kind: 'error', text: t.compactCancelled }
  try {
    const result = await compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'success', text: t.compactNoHistory }
    return {
      kind: 'success',
      text: t.compactSucceeded(result.shadowedSeqs.length, result.shadowedTokenCount),
      sourceEventSeq: result.summarySeq,
    }
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: 'error', text: t.compactCancelled }
    const message = error instanceof Error ? error.message : String(error)
    if (/busy/i.test(message)) return { kind: 'error', text: t.compactBusy }
    if (/changed/i.test(message)) return { kind: 'error', text: t.compactChanged }
    throw error
  }
}