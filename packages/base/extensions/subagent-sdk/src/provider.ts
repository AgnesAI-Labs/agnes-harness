import { assertChildAgentAllowed } from '@agnes/core'
import type {
  ChildAgentCapabilities,
  ChildAgentPluginContext,
  ChildAgentProvider,
  ChildAgentStartOptions,
} from '@agnes/extension-api'
import { acpChildAgentProvider } from '../../subagent-acp/src/provider.js'
import { DISABLED_CHILD_ENGINES, readSdkEngineDocument } from './document.js'
import { assertEngineLaunch, type EngineLaunch } from './launch.js'
import { attachOneShot, listEngineChildren, refuseUnsupportedChildOptions } from './oneshot.js'
import { EngineProcess } from './process.js'

export const SDK_CHILD_PROVIDER_ID = 'sdk'

/** One pinned SDK process per turn. It does not speak the DeepSeek SDK wire. */
export const SDK_CHILD_CAPABILITIES: ChildAgentCapabilities = Object.freeze({
  continuable: false,
  interrupt: true,
  modelSelection: false,
  inheritsParentContext: false,
  worktree: false,
  budget: false,
  toolFilter: false,
})

export type SdkChildEngineConfig = EngineLaunch & {
  /** `sdk` is one shot. `acp` registers the existing continuable ACP provider id `acp`. */
  protocol: 'sdk' | 'acp'
}

export const DEFAULT_SDK_CHILD_ENGINE: SdkChildEngineConfig = DISABLED_CHILD_ENGINES.sdk

type SdkLine = {
  id?: number
  method?: string
  result?: { status?: string }
  error?: { message?: string }
  params?: { text?: string }
}

/** Pinned `agnes.child-engine` line protocol: initialize, run, text notifications, cancel. */
export function interpretSdk(
  message: unknown,
):
  | { kind: 'text'; text: string }
  | { kind: 'done'; status: 'completed' | 'failed' | 'cancelled' }
  | { kind: 'ignore' } {
  if (!message || typeof message !== 'object') return { kind: 'ignore' }
  const line = message as SdkLine
  if (line.method === 'text' && line.params?.text) return { kind: 'text', text: line.params.text }
  if (line.error) return { kind: 'done', status: 'failed' }
  const status = line.result?.status
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return { kind: 'done', status }
  return { kind: 'ignore' }
}

function prepare(
  task: string,
  options: ChildAgentStartOptions,
  config: SdkChildEngineConfig,
  providerId: string,
  capabilities: ChildAgentCapabilities,
): void {
  if (!task) throw new Error('child task must not be empty')
  options.signal.throwIfAborted()
  refuseUnsupportedChildOptions(options, capabilities)
  assertChildAgentAllowed(options.sessionKey, { providerId })
  if (!options.cwd) throw new Error('child engine requires a working directory')
  assertEngineLaunch(config)
}

export function sdkChildAgentProvider(config: SdkChildEngineConfig): ChildAgentProvider {
  if (config.protocol === 'acp') {
    const inner = acpChildAgentProvider({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
    })
    return {
      id: inner.id,
      version: '1.0.0',
      capabilities: inner.capabilities,
      list: (sessionKey) => inner.list?.(sessionKey) ?? Promise.resolve([]),
      async start(task, options) {
        prepare(task, options, config, inner.id, inner.capabilities)
        return inner.start(task, options)
      },
    }
  }
  const capabilities = SDK_CHILD_CAPABILITIES
  return {
    id: SDK_CHILD_PROVIDER_ID,
    version: '1.0.0',
    capabilities,
    list: async (sessionKey) => listEngineChildren(sessionKey, SDK_CHILD_PROVIDER_ID),
    async start(task, options) {
      prepare(task, options, config, SDK_CHILD_PROVIDER_ID, capabilities)
      const proc = new EngineProcess({
        command: config.command,
        args: [...(config.args ?? [])],
        cwd: options.cwd as string,
        ...(config.env ? { env: config.env } : {}),
      })
      const handle = attachOneShot({
        idPrefix: 'sdk',
        providerId: SDK_CHILD_PROVIDER_ID,
        capabilities,
        options,
        process: proc,
        interpret: interpretSdk,
        cancel: () => proc.write({ jsonrpc: '2.0', method: 'cancel' }),
      })
      proc.write({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocol: 'agnes.child-engine', version: 1 },
      })
      proc.write({ jsonrpc: '2.0', id: 2, method: 'run', params: { task } })
      return handle
    },
  }
}

export const sdkChildAgentsPlugin = {
  inject: ['childAgents'] as const,
  apply(ctx: ChildAgentPluginContext, config?: unknown) {
    const parsed = readSdkEngineDocument(config)
    if (!parsed?.enabled) return
    assertEngineLaunch(parsed)
    return ctx.childAgents.register(sdkChildAgentProvider(parsed))
  },
}
