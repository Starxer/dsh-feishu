import type { CommandTranslations } from './commands.ts'

/** Format a token count as a compact human-readable number (e.g. 12.3K). */
function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${Math.round(n / 100_000) / 10}M`
}

/** Format a millisecond duration as a short human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

/** Simplified-Chinese implementation of `CommandTranslations`. */
export const zhCommandTranslations: CommandTranslations = {
  modelDescription: '查看、列出或切换当前模型',
  modelCurrentHeader: '当前模型：',
  modelUsage: '用法：/model [list|<provider>/<model>[:reasoning]]',
  modelListHeader: '可用模型：',
  modelListEmpty: '暂无已注册的 provider。',
  modelSwitched: (provider, model) => `已将默认模型切换为 \`${provider}/${model}\`。`,
  modelUnknown: route => `未知模型路由 "${route}"。`,
  modelPersisted: '该修改已持久化；本聊天下一条消息将使用它。',
  modelLiveApplied: '该修改在下一条消息时立即对本聊天生效。',
  newDescription: '在本聊天创建新会话（卡片流程，或 /new <workspace> <Agent 预设> [model]）',
  newUsage: '用法：/new <workspace> <Agent 预设> [provider/model[:reasoning]] — 或直接运行 `/new`（不带参数）走卡片流程。',
  newSessionReady: sessionId => `已开始新对话。下一条消息将使用会话 \`${sessionId}\`。`,
  threadDescription: '列出已持久化的会话，或按下标把聊天切换到某个会话',
  threadUsage: '用法：/session [N]',
  threadListHeader: '可用会话（回复 `/session N` 切换）：',
  threadListEmpty: '暂无已持久化的会话。',
  threadListEntry: (index, id, title, lastActive) => `${index}. ${title} — ${lastActive} (\`${id}\`)`,
  threadListEntryOwned: (index, id, title, lastActive, ownerLabel) => `${index}. ${title} — ${lastActive} — 🔒 ${ownerLabel} 正在使用 (\`${id}\`)`,
  threadSwitched: (index, id) => `已切换到会话 #${index} (\`${id}\`)。`,
  threadInvalidIndex: '无效的会话下标。',
  threadArchived: '该会话已归档——请先从工作区 WebUI 取消归档。',
  threadOccupied: ownerLabel => `该会话正被 ${ownerLabel} 占用。请选择一个空闲会话，或对它运行 \`/detach\` 强制释放。`,
  threadIdle: id => `(空闲：${id.slice(-12)})`,
  detachDescription: '强制释放某个会话，使任意对话框都能切换过去',
  detachUsage: '用法：/detach <N>',
  detachInvalidIndex: '无效的会话下标。',
  detachFree: '该会话已是空闲状态——没有对话框占用它。',
  detachReleased: (index, id, ownerLabel) => `🔓 已释放会话 #${index} (\`${id}\`)。${ownerLabel} 已重置为一个全新会话，无法再占用它。`,
  threadLastActiveJustNow: '刚刚',
  threadLastActiveMinutesAgo: n => `${n} 分钟前`,
  threadLastActiveHoursAgo: n => `${n} 小时前`,
  threadLastActiveDaysAgo: n => `${n} 天前`,
  threadLastActiveUnknown: '未知',
  helpDescription: '列出本聊天所有可用的斜杠命令',
  helpFeishuHeader: '**🔹 chatterbox4dsh 插件：**',
  helpNativeHeader: '**💠 DSH 内置：**',
  helpUsage: '发送 `/<name> [参数]` 来运行命令。可选输入提示以 `[brackets]` 形式显示。',
  helpEntry: (name, description, hint) => hint === undefined
    ? `• \`/${name}\` — ${description}`
    : `• \`/${name}\` — ${description} \`[${hint}]\``,
  helpEmpty: '当前没有可用的斜杠命令。',
  approveDescription: '批准本聊天最近一个（或 `<shortCode>` 指定的）待审批项',
  approveApproveHint: '[shortCode]',
  approveApprovedNoPending: '本会话没有待审批项——无需批准。',
  approveApproved: (shortCode, toolName) => `✅ 已批准 \`${toolName}\` (\`${shortCode}\`)。Agent 继续。`,
  approveUnknownShort: shortCode => `本会话没有 id 为 \`${shortCode}\` 的待审批项。`,
  denyDescription: '拒绝本聊天最近一个（或 `<shortCode>` 指定的）待审批项',
  denyHint: '[shortCode]',
  denyDenied: (shortCode, toolName) => `❌ 已拒绝 \`${toolName}\` (\`${shortCode}\`)。Agent 停止。`,
  approveDenyUsage: '用法：`/approve` 或 `/approve <shortCode>`（`/deny` 同理）。运行 `/approvals` 查看 short codes。',
  approvalsDescription: '列出本聊天所有待审批项及其 short code',
  approvalsEmpty: '本会话没有待审批项。',
  approvalsHeader: '待审批项（最新在前）：',
  approvalsEntry: (index, shortCode, toolName, age) => `${index}. \`${shortCode}\` — \`${toolName}\` — ${age}`,
  approvalsAgeJustNow: '刚刚',
  approvalsAgeSeconds: n => `${n} 秒前`,
  approvalsAgeMinutes: n => `${n} 分钟前`,
  approvalsAgeHours: n => `${n} 小时前`,
  statusDescription: '显示当前会话状态（工作区、Agent 预设、模型、统计）',
  statusOutput: (meta) => {
    const lines = [
      '**会话状态**',
      `• 会话：\`${meta.sessionId}\``,
    ]
    if (meta.title !== '') lines.push(`• 标题：${meta.title}`)
    lines.push(
      `• 工作区：\`${meta.workspace || '(default)'}\``,
      `• Agent 预设：\`${meta.agentPreset || '(default)'}\``,
      `• 模型：\`${meta.model}\``,
    )
    if (meta.turns > 0 || meta.steps > 0) {
      const parts: string[] = [`${meta.turns} 轮`, `${meta.steps} 步`]
      if (meta.toolCalls > 0) parts.push(`${meta.toolCalls} 次工具调用`)
      lines.push(`• 活动：${parts.join(' · ')}`)
      if (meta.inputTokens > 0 || meta.outputTokens > 0) {
        lines.push(`• Token：${formatTokenCount(meta.inputTokens)} 进 · ${formatTokenCount(meta.outputTokens)} 出`)
      }
      if (meta.cacheHitRate > 0) {
        lines.push(`• 缓存命中：${meta.cacheHitRate}%`)
      }
      if (meta.llmDurationMs > 0 || meta.toolDurationMs > 0) {
        const durParts: string[] = []
        if (meta.llmDurationMs > 0) durParts.push(`LLM ${formatDuration(meta.llmDurationMs)}`)
        if (meta.toolDurationMs > 0) durParts.push(`工具 ${formatDuration(meta.toolDurationMs)}`)
        lines.push(`• 时长：${durParts.join(' · ')}`)
      }
      if (meta.ttftAvgMs > 0) {
        lines.push(`• TTFT 平均：${formatDuration(meta.ttftAvgMs)}`)
      }
      if (meta.tokensPerSecond > 0) {
        lines.push(`• 吞吐：${meta.tokensPerSecond} tok/s`)
      }
    }
    if (meta.contextWindow > 0) {
      const pct = Math.min(100, Math.round(meta.lastInputTokens / meta.contextWindow * 100))
      lines.push(`• 上下文：${formatTokenCount(meta.lastInputTokens)} / ${formatTokenCount(meta.contextWindow)} (${pct}%)`)
    }
    return lines.join('\n')
  },
  streamDescription: '切换 Agent 运行期间的中间消息显示',
  stopDescription: '停止本聊天当前运行中的 Agent（同 WebUI 停止按钮）',
  reasoningDescription: '查看或更改模型推理强度（思考强度）',
  reasoningUsage: '用法：/reasoning [off|low|high|max] [show on|off]',
  reasoningCurrent: (effort: string) => `🧠 当前推理强度：**${effort}**`,
  reasoningCurrentDefault: '(provider 默认)',
  reasoningSwitched: (effort: string) => `🧠 推理强度已切换为 **${effort}**。跨重启持久化。`,
  reasoningLevels: '可用档位：`off` · `low` · `high` · `max`\n使用 `/reasoning show on|off` 切换推理内容显示。',
  reasoningUnknown: (level: string) => `未知推理档位 "${level}"。`,
  reasoningShowToggled: (enabled: boolean) => `🧠 推理内容显示：**${enabled ? 'on' : 'off'}**。跨重启持久化。`,
}

/** English implementation of `CommandTranslations`. */
export const enCommandTranslations: CommandTranslations = {
  modelDescription: 'Show, list, or switch the active model',
  modelCurrentHeader: 'Current model:',
  modelUsage: 'Usage: /model [list|<provider>/<model>[:reasoning]]',
  modelListHeader: 'Available models:',
  modelListEmpty: 'No registered providers are available.',
  modelSwitched: (provider, model) => `Switched default model to \`${provider}/${model}\`.`,
  modelUnknown: route => `Unknown model route "${route}".`,
  modelPersisted: 'The change is persisted; the next message in this chat will use it.',
  modelLiveApplied: 'The change applies to this chat immediately on the next message.',
  newDescription: 'Create a new session in this chat (card flow, or /new <workspace> <preset> [model])',
  newUsage: 'Usage: /new <workspace> <agentPreset> [provider/model[:reasoning]] — or run `/new` with no arguments for the card flow.',
  newSessionReady: sessionId => `Started a new conversation. Next message uses session \`${sessionId}\`.`,
  threadDescription: 'List persisted sessions or switch the chat to one by index',
  threadUsage: 'Usage: /session [N]',
  threadListHeader: 'Available sessions (reply with `/session N` to switch):',
  threadListEmpty: 'No persisted sessions yet.',
  threadListEntry: (index, id, title, lastActive) => `${index}. ${title} — ${lastActive} (\`${id}\`)`,
  threadListEntryOwned: (index, id, title, lastActive, ownerLabel) => `${index}. ${title} — ${lastActive} — 🔒 ${ownerLabel} is using (\`${id}\`)`,
  threadSwitched: (index, id) => `Switched to session #${index} (\`${id}\`).`,
  threadInvalidIndex: 'Invalid session index.',
  threadArchived: 'That session is archived — unarchive it from the workspace webui first.',
  threadOccupied: ownerLabel => `That session is already in use by ${ownerLabel}. Pick a free session, or run \`/detach\` on it to force-release it.`,
  threadIdle: id => `(idle: ${id.slice(-12)})`,
  detachDescription: 'Force-release a session so any dialog can switch to it',
  detachUsage: 'Usage: /detach <N>',
  detachInvalidIndex: 'Invalid session index.',
  detachFree: 'That session is already free — no dialog owns it.',
  detachReleased: (index, id, ownerLabel) => `🔓 Released session #${index} (\`${id}\`). ${ownerLabel} was reset to a brand-new session and can no longer hold it.`,
  threadLastActiveJustNow: 'just now',
  threadLastActiveMinutesAgo: n => `${n}m ago`,
  threadLastActiveHoursAgo: n => `${n}h ago`,
  threadLastActiveDaysAgo: n => `${n}d ago`,
  threadLastActiveUnknown: 'unknown',
  helpDescription: 'List every slash command available in this chat',
  helpFeishuHeader: '**🔹 chatterbox4dsh plugin:**',
  helpNativeHeader: '**💠 DSH built-in:**',
  helpUsage: 'Send `/<name> [arguments]` to run a command. Optional input hints appear in `[brackets]`.',
  helpEntry: (name, description, hint) => hint === undefined
    ? `• \`/${name}\` — ${description}`
    : `• \`/${name}\` — ${description} \`[${hint}]\``,
  helpEmpty: 'No slash commands are available right now.',
  approveDescription: 'Approve the most recent (or `<shortCode>`) pending approval in this chat',
  approveApproveHint: '[shortCode]',
  approveApprovedNoPending: 'No pending approvals on this session — nothing to approve.',
  approveApproved: (shortCode, toolName) => `✅ Approved \`${toolName}\` (\`${shortCode}\`). The agent continues.`,
  approveUnknownShort: shortCode => `No pending approval with id \`${shortCode}\` on this session.`,
  denyDescription: 'Reject the most recent (or `<shortCode>`) pending approval in this chat',
  denyHint: '[shortCode]',
  denyDenied: (shortCode, toolName) => `❌ Rejected \`${toolName}\` (\`${shortCode}\`). The agent stops.`,
  approveDenyUsage: 'Usage: `/approve` or `/approve <shortCode>` (and `/deny` likewise). Run `/approvals` to see the short codes.',
  approvalsDescription: 'List every pending approval for this chat with its short code',
  approvalsEmpty: 'No pending approvals on this session.',
  approvalsHeader: 'Pending approvals (newest first):',
  approvalsEntry: (index, shortCode, toolName, age) => `${index}. \`${shortCode}\` — \`${toolName}\` — ${age}`,
  approvalsAgeJustNow: 'just now',
  approvalsAgeSeconds: n => `${n}s ago`,
  approvalsAgeMinutes: n => `${n}m ago`,
  approvalsAgeHours: n => `${n}h ago`,
  statusDescription: 'Show current session status (workspace, preset, model, stats)',
  statusOutput: (meta) => {
    const lines = [
      '**Session Status**',
      `• Session: \`${meta.sessionId}\``,
    ]
    if (meta.title !== '') lines.push(`• Title: ${meta.title}`)
    lines.push(
      `• Workspace: \`${meta.workspace || '(default)'}\``,
      `• Preset: \`${meta.agentPreset || '(default)'}\``,
      `• Model: \`${meta.model}\``,
    )
    if (meta.turns > 0 || meta.steps > 0) {
      const parts: string[] = [`${meta.turns} turns`, `${meta.steps} steps`]
      if (meta.toolCalls > 0) parts.push(`${meta.toolCalls} tool calls`)
      lines.push(`• Activity: ${parts.join(' · ')}`)
      if (meta.inputTokens > 0 || meta.outputTokens > 0) {
        lines.push(`• Tokens: ${formatTokenCount(meta.inputTokens)} in · ${formatTokenCount(meta.outputTokens)} out`)
      }
      if (meta.cacheHitRate > 0) {
        lines.push(`• Cache hit: ${meta.cacheHitRate}%`)
      }
      if (meta.llmDurationMs > 0 || meta.toolDurationMs > 0) {
        const durParts: string[] = []
        if (meta.llmDurationMs > 0) durParts.push(`LLM ${formatDuration(meta.llmDurationMs)}`)
        if (meta.toolDurationMs > 0) durParts.push(`Tools ${formatDuration(meta.toolDurationMs)}`)
        lines.push(`• Duration: ${durParts.join(' · ')}`)
      }
      if (meta.ttftAvgMs > 0) {
        lines.push(`• TTFT avg: ${formatDuration(meta.ttftAvgMs)}`)
      }
      if (meta.tokensPerSecond > 0) {
        lines.push(`• Throughput: ${meta.tokensPerSecond} tok/s`)
      }
    }
    if (meta.contextWindow > 0) {
      const pct = Math.min(100, Math.round(meta.lastInputTokens / meta.contextWindow * 100))
      lines.push(`• Context: ${formatTokenCount(meta.lastInputTokens)} / ${formatTokenCount(meta.contextWindow)} (${pct}%)`)
    }
    return lines.join('\n')
  },
  streamDescription: 'Toggle intermediate assistant messages during agent turns',
  stopDescription: 'Stop the currently running agent in this chat (like the WebUI stop button)',
  reasoningDescription: 'Show or change the model reasoning effort (thinking intensity)',
  reasoningUsage: 'Usage: /reasoning [off|low|high|max] [show on|off]',
  reasoningCurrent: (effort: string) => `🧠 Current reasoning effort: **${effort}**`,
  reasoningCurrentDefault: '(provider default)',
  reasoningSwitched: (effort: string) => `🧠 Reasoning effort switched to **${effort}**. Persisted across restarts.`,
  reasoningLevels: 'Available levels: `off` · `low` · `high` · `max`\nUse `/reasoning show on|off` to toggle reasoning content display.',
  reasoningUnknown: (level: string) => `Unknown reasoning level "${level}".`,
  reasoningShowToggled: (enabled: boolean) => `🧠 Reasoning content display: **${enabled ? 'on' : 'off'}**. Persisted across restarts.`,
}

/**
 * Return the translations object for the requested locale. Falls back to the
 * English implementation for any locale other than `zh`.
 */
export function commandTranslationsFor(locale: 'zh' | 'en'): CommandTranslations {
  return locale === 'zh' ? zhCommandTranslations : enCommandTranslations
}
