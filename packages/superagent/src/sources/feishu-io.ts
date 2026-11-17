/** Trusted-backend Feishu I/O, bound to the resolved bot and the source's current configuration. */
import type { FeishuBot } from '../deployment.js'
import { botIdentity } from '../feishu-setup.js'
import type { FeishuConfig } from './feishu.js'
import type { SourceContext } from './host.js'

export interface FeishuCommands {
  lark<T>(args: string[], cwd?: string, input?: string): Promise<T>
  withSignal(signal?: AbortSignal): FeishuCommands
}
export interface FeishuIo {
  readonly commands: FeishuCommands
  readonly bot: FeishuBot
  readonly stateDir: string
  readonly signal?: AbortSignal | undefined
  assertCurrent(): void
}
export interface FeishuLink {
  context?: SourceContext
  log?(message: string): void
  readonly logged: Map<string, string>
  listening: boolean
  /** Aborts reads as well as the consumer when disabled, reconfigured or stopped. */
  signal?: AbortSignal | undefined
}
export const feishuLink = (log?: (message: string) => void): FeishuLink => ({
  logged: new Map(),
  listening: false,
  ...(log ? { log } : {}),
})
export function linkIo(link: FeishuLink, signal?: AbortSignal): FeishuIo {
  const ctx = link.context
  const config = ctx?.config<FeishuConfig>('feishu')
  const bot = ctx?.configured() ? ctx.deployment.feishu : undefined
  if (!ctx || !config || !bot || config.cli !== bot.cli)
    throw new Error('The Feishu Source needs a verified bot CLI')
  const combined = [signal, link.signal].filter((value): value is AbortSignal => !!value)
  const active = combined.length ? AbortSignal.any(combined) : undefined
  const assertCurrent = () => {
    active?.throwIfAborted()
    const current = ctx.config<FeishuConfig>('feishu')
    const resolved = ctx.configured() ? ctx.deployment.feishu : undefined
    if (!current || current.cli !== bot.cli || !resolved || botIdentity(resolved) !== botIdentity(bot))
      throw new Error('The Feishu Source bot changed or was disabled')
  }
  assertCurrent()
  const commands = ctx.commands.withSignal(active)
  return {
    bot,
    stateDir: ctx.deployment.stateDir,
    signal: active,
    assertCurrent,
    commands: {
      withSignal(signal) {
        return linkIo(link, signal ? AbortSignal.any([...(active ? [active] : []), signal]) : active).commands
      },
      async lark<T>(args: string[], cwd?: string, input?: string): Promise<T> {
        assertCurrent()
        const value = await commands.lark<T>(args, cwd, input)
        assertCurrent()
        return value
      },
    },
  }
}
export function requireIdentity(io: FeishuIo, identity: unknown): void {
  io.assertCurrent()
  if (identity !== botIdentity(io.bot))
    throw new Error(
      'This work belongs to a different or unverified Feishu bot; restore its original bot or start a new request',
    )
}
export const withSignal = (io: FeishuIo, signal?: AbortSignal): FeishuIo => ({
  ...io,
  commands: io.commands.withSignal(signal),
  signal: signal ? (io.signal ? AbortSignal.any([io.signal, signal]) : signal) : io.signal,
  assertCurrent() {
    signal?.throwIfAborted()
    io.assertCurrent()
  },
})
