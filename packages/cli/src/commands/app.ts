import { daemonStatus } from '@agnes/daemon'
import { createConfigurationService } from '@agnes/host'
import { createClient, memoryJournal, unixTransport } from '@agnes/sdk'
import type { MainIO } from '../bin.js'
import { profileNameFrom } from '../boot/inputs.js'
import type { ParsedArgs } from '../types.js'

/** Recovery dispatch: never loads a profile, package lock, plugin or execution Host. */
export async function clearApplicationCommand(p: ParsedArgs, io: MainIO, home: string): Promise<number> {
  try {
    const args = [...p.rest]
    if (args.shift() !== 'clear') throw new Error('Usage: agh app clear [--profile NAME] [--json]')
    let profile = p.profile
    let json = p.json ?? false
    while (args.length) {
      const flag = args.shift()
      if (flag === '--json') json = true
      else if (flag === '--profile' && args[0]) profile = args.shift()
      else throw new Error('Usage: agh app clear [--profile NAME] [--json]')
    }
    const name = profileNameFrom({ ...p, ...(profile ? { profile } : {}) }, io.env)
    const state = await daemonStatus(home)
    if (state.running) {
      if (!state.socketReachable || !state.owner)
        throw new Error('The daemon is running but unavailable; retry when its connection recovers.')
      const owner = state.owner
      const client = createClient({
        transport: { kind: 'unix', path: state.owner.socketPath },
        transportFactories: {
          unix: () =>
            unixTransport({
              path: owner.socketPath,
              ...(owner.socketPath.startsWith('\\\\.\\pipe\\')
                ? {
                    resolveServerIdentity: async () => {
                      const current = await daemonStatus(home)
                      if (
                        !current.running ||
                        current.owner?.generation !== owner.generation ||
                        current.owner.pid !== owner.pid ||
                        current.owner.processStartId !== owner.processStartId ||
                        current.owner.socketPath !== owner.socketPath
                      )
                        throw new Error('The daemon identity changed; retry application recovery.')
                      return { pid: owner.pid, processStartId: owner.processStartId }
                    },
                  }
                : {}),
            }),
        },
        auth: { kind: 'local' },
        journal: memoryJournal('app-recovery'),
      })
      try {
        await client.initialize()
        const current = await client.request('_agnes/v1/applications.get', { profile: name })
        await client.request('_agnes/v1/applications.clear', {
          profile: name,
          expectedRevision: current.revision,
          clientId: await client.clientId(),
          commandId: 'clear-application',
        })
      } finally {
        await client.close()
      }
    } else {
      const config = createConfigurationService({ home, profile: name })
      const current = await config.application()
      await config.saveApplication({ revision: current.revision, selection: null, roleSelections: {} })
    }
    io.stdout.write(
      json
        ? '{"cleared":true}\n'
        : io.env.AGNES_LOCALE === 'zh-CN'
          ? '已清除当前应用与界面实现选择。\n'
          : 'Current application and interface choices cleared.\n',
    )
    return 0
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : 'Application recovery failed'}\n`)
    return 1
  }
}

/** The only maintenance commands that deliberately bypass generic profile/Host boot. */
export async function recoveryCommand(p: ParsedArgs, io: MainIO, home: string): Promise<number | undefined> {
  if (p.command === 'app' && !['show', 'preview', 'adopt'].includes(p.rest[0] ?? ''))
    return clearApplicationCommand(p, io, home)
  if (p.command === 'home') {
    const { homeCommand } = await import('./home.js')
    return homeCommand(p.rest, io)
  }
  return undefined
}
