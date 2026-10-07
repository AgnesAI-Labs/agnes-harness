import { assertChildAgentAllowed } from '@agnes/core'
import type {
  ChildAgentCapabilities,
  ChildAgentPluginContext,
  ChildAgentProvider,
  ChildAgentStartOptions,
} from '@agnes/extension-api'
import { DISABLED_CHILD_ENGINES, readEngineDocument } from '../../subagent-sdk/src/document.js'
import { assertEngineLaunch, type EngineLaunch, engineArgs } from '../../subagent-sdk/src/launch.js'
import {
  attachOneShot,
  listEngineChildren,
  refuseUnsupportedChildOptions,
} from '../../subagent-sdk/src/oneshot.js'
import { EngineProcess } from '../../subagent-sdk/src/process.js'

export const CLAUDE_CODE_CHILD_PROVIDER_ID = 'claude-code'

/** One Claude Code CLI turn. Native Claude settings choose the model and tools. */
export const CLAUDE_CODE_CHILD_CAPABILITIES: ChildAgentCapabilities = Object.freeze({
  continuable: false,
  interrupt: true,
  modelSelection: false,
  inheritsParentContext: false,
  worktree: false,
  budget: false,
  toolFilter: false,
})

export type ClaudeCodeChildEngineConfig = EngineLaunch

export const DEFAULT_CLAUDE_CODE_CHILD_ENGINE: ClaudeCodeChildEngineConfig = DISABLED_CHILD_ENGINES.claudeCode

type ClaudeBlock = { type?: string; text?: string }
type ClaudeLine = {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  message?: { content?: ClaudeBlock[] }
}

/** Claude Code `stream-json` events. The final result is used only when no assistant text arrived. */
export function interpretClaude(
  message: unknown,
):
  | { kind: 'text'; text: string }
  | { kind: 'done'; status: 'completed' | 'failed'; text?: string }
  | { kind: 'ignore' } {
  if (!message || typeof message !== 'object') return { kind: 'ignore' }
  const line = message as ClaudeLine
  if (line.type === 'assistant' && Array.isArray(line.message?.content)) {
    const text = line.message.content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('')
    return text ? { kind: 'text', text } : { kind: 'ignore' }
  }
  if (line.type === 'result') {
    if (line.subtype === 'success' && line.is_error !== true)
      return { kind: 'done', status: 'completed', ...(line.result ? { text: line.result } : {}) }
    return { kind: 'done', status: 'failed' }
  }
  return { kind: 'ignore' }
}

function prepare(task: string, options: ChildAgentStartOptions, config: ClaudeCodeChildEngineConfig): void {
  if (!task) throw new Error('child task must not be empty')
  options.signal.throwIfAborted()
  refuseUnsupportedChildOptions(options, CLAUDE_CODE_CHILD_CAPABILITIES)
  assertChildAgentAllowed(options.sessionKey, { providerId: CLAUDE_CODE_CHILD_PROVIDER_ID })
  if (!options.cwd) throw new Error('child engine requires a working directory')
  assertEngineLaunch(config)
}

export function claudeCodeChildAgentProvider(config: ClaudeCodeChildEngineConfig): ChildAgentProvider {
  const capabilities = CLAUDE_CODE_CHILD_CAPABILITIES
  return {
    id: CLAUDE_CODE_CHILD_PROVIDER_ID,
    version: '1.0.0',
    capabilities,
    list: async (sessionKey) => listEngineChildren(sessionKey, CLAUDE_CODE_CHILD_PROVIDER_ID),
    async start(task, options) {
      prepare(task, options, config)
      const proc = new EngineProcess({
        command: config.command,
        args: engineArgs(config.args, task),
        cwd: options.cwd as string,
        ...(config.env ? { env: config.env } : {}),
      })
      return attachOneShot({
        idPrefix: 'claude-code',
        providerId: CLAUDE_CODE_CHILD_PROVIDER_ID,
        capabilities,
        options,
        process: proc,
        interpret: interpretClaude,
      })
    },
  }
}

export const claudeCodeChildAgentsPlugin = {
  inject: ['childAgents'] as const,
  apply(ctx: ChildAgentPluginContext, config?: unknown) {
    const parsed = readEngineDocument(config)
    if (!parsed?.enabled) return
    assertEngineLaunch(parsed)
    return ctx.childAgents.register(claudeCodeChildAgentProvider(parsed))
  },
}
