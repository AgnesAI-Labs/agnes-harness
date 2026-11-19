// Adapted from dsh-superagent (MIT)
/** Bot identity checks for the trusted backend's configured lark-cli wrapper. No credentials are retained. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { executable, type FeishuBot, type Machine, type Probe } from './deployment.js'
import { workerBin } from './infra/worker-paths.js'
import { SetupError } from './setup.js'

const AuthStatus = z.object({
  appId: z.string().regex(/^cli_[A-Za-z0-9]+$/),
  brand: z.enum(['feishu', 'lark']).default('feishu'),
  identities: z.object({ bot: z.object({ status: z.string() }) }),
})
export const BotInfo = z.object({
  bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }),
})
export const botIdentity = (bot: FeishuBot): string => `${bot.brand}:${bot.appId}:${bot.botId}`

/** Refuse missing, unauthenticated or user-capable wrappers. Diagnostic stdout/stderr may contain secrets. */
export async function resolveFeishuBot(machine: Machine, config: unknown, probe: Probe): Promise<FeishuBot> {
  const { cli: name } = z.object({ cli: z.string().trim().default('') }).parse(config ?? {})
  if (!name) throw new SetupError('feishuCliUnset')
  let cli: string
  try {
    if (!isAbsolute(name)) throw new Error('Absolute path required')
    cli = executable(name, '', workerBin(machine.stateDir))
  } catch {
    throw new SetupError('feishuCliMissing')
  }
  const run = async (...args: string[]) => {
    try {
      return await probe([cli, ...args])
    } catch {
      throw new SetupError('feishuCliFailed')
    }
  }
  let status: z.infer<typeof AuthStatus>
  try {
    const text = await run('auth', 'status')
    status = AuthStatus.parse(JSON.parse(text.slice(text.indexOf('{'))))
  } catch {
    throw new SetupError('feishuCliFailed')
  }
  if (status.identities.bot.status !== 'ready') throw new SetupError('feishuBotNotReady')
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') throw new SetupError('feishuUserIdentity')
  let info: z.infer<typeof BotInfo>
  try {
    const text = await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')
    info = BotInfo.parse(JSON.parse(text.trim()))
  } catch {
    throw new SetupError('feishuNoBot')
  }
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
