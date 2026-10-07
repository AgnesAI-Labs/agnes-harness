import { assertChildAgentAllowed } from '@agnes/core'
import type {
  ChildAgentCapabilities,
  ChildAgentPluginContext,
  ChildAgentProvider,
  ChildAgentStartOptions,
} from '@agnes/extension-api'
import { DISABLED_CHILD_ENGINES } from '../../subagent-sdk/src/document.js'
import { assertEngineLaunch, type EngineLaunch, engineArgs } from '../../subagent-sdk/src/launch.js'
import {
  attachOneShot,
  listEngineChildren,
  refuseUnsupportedChildOptions,
} from '../../subagent-sdk/src/oneshot.js'
import { EngineProcess } from '../../subagent-sdk/src/process.js'

export const CODEX_CHILD_PROVIDER_ID = 'codex'

/** One Codex CLI turn. Native Codex config chooses the model, tools, and sandbox. */
export const CODEX_CHILD_CAPABILITIES: ChildAgentCapabilities = Object.freeze({
  continuable: false,
  interrupt: true,
  modelSelection: false,
  inheritsParentContext: false,
  worktree: false,
  budget: false,
  toolFilter: false,
})

export type CodexChildEngineConfig = EngineLaunch

export const DEFAULT_CODEX_CHILD_ENGINE: CodexChildEngineConfig = DISABLED_CHILD_ENGINES.codex

type CodexItem = { type?: string; text?: string }
type CodexLine = { type?: string; item?: CodexItem }

/** Codex `exec --json` events. Full agent messages are appended once, at item completion. */
export function interpretCodex(
  message: unknown,
): { kind: 'text'; text: string } | { kind: 'done'; status: 'completed' | 'failed' } | { kind: 'ignore' } {
  if (!message || typeof message !== 'object') return { kind: 'ignore' }
  const line = message as CodexLine
  if (line.type === 'item.completed' && line.item?.type === 'agent_message' && line.item.text)
    return { kind: 'text', text: line.item.text }
  if (line.type === 'turn.completed') return { kind: 'done', status: 'completed' }
  if (line.type === 'turn.failed' || line.type === 'error') return { kind: 'done', status: 'failed' }
  return { kind: 'ignore' }
}

function prepare(task: string, options: ChildAgentStartOptions, config: CodexChildEngineConfig): void {
  if (!task) throw new Error('child task must not be empty')
  options.signal.throwIfAborted()
  refuseUnsupportedChildOptions(options, CODEX_CHILD_CAPABILITIES)
  assertChildAgentAllowed(options.sessionKey, { providerId: CODEX_CHILD_PROVIDER_ID })
  if (!options.cwd) throw new Error('child engine requires a working directory')
  assertEngineLaunch(config)
}

export function codexChildAgentProvider(config: CodexChildEngineConfig): ChildAgentProvider {
  const capabilities = CODEX_CHILD_CAPABILITIES
  return {
    id: CODEX_CHILD_PROVIDER_ID,
    version: '1.0.0',
    capabilities,
    list: async (sessionKey) => listEngineChildren(sessionKey, CODEX_CHILD_PROVIDER_ID),
    async start(task, options) {
      prepare(task, options, config)
      const proc = new EngineProcess({
        command: config.command,
        args: engineArgs(config.args, task),
        cwd: options.cwd as string,
        ...(config.env ? { env: config.env } : {}),
      })
      return attachOneShot({
        idPrefix: 'codex',
        providerId: CODEX_CHILD_PROVIDER_ID,
        capabilities,
        options,
        process: proc,
        interpret: interpretCodex,
      })
    },
  }
}

export function codexChildAgentsPlugin(config: CodexChildEngineConfig = DEFAULT_CODEX_CHILD_ENGINE) {
  const provider = codexChildAgentProvider(config)
  return {
    inject: ['childAgents'] as const,
    apply(ctx: ChildAgentPluginContext) {
      if (!config.enabled) return
      assertEngineLaunch(config)
      return ctx.childAgents.register(provider)
    },
  }
}
