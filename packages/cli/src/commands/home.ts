import { agnesHome, homeVersionMessage, initializeLlmsgHomeLocked, inspectHome } from '@agnes/host'
import type { MainIO } from '../bin.js'
import { startupFailure } from './first-run-locales.js'

export async function homeCommand(argv: readonly string[], io: MainIO): Promise<number> {
  const llmsg =
    argv.length === 1 && (argv[0] === '--llmsg-init' || argv[0] === '--llmsg-persist-key')
      ? argv[0]
      : undefined
  if (!llmsg && ((argv[0] ?? 'info') !== 'info' || argv.slice(1).some((flag) => flag !== '--json')))
    throw new Error('Usage: agh home info [--json]')
  try {
    const home = agnesHome(io.env)
    const profile = io.env.AGNES_PROFILE ?? 'local-dev'
    if (llmsg) {
      await initializeLlmsgHomeLocked(
        home,
        profile,
        io.env,
        llmsg === '--llmsg-init' ? 'layout' : 'persist-key',
      )
      return 0
    }
    const info = inspectHome(home, profile)
    io.stdout.write(JSON.stringify(info, null, 2) + '\n')
    if (info.state === 'unsupported') {
      io.stderr.write(
        homeVersionMessage(
          { code: 'E_HOME_VERSION', home: info.home, reason: 'unversioned' },
          io.env.AGNES_LOCALE,
        ) + '\n',
      )
      return 1
    }
    return 0
  } catch (error) {
    const message =
      startupFailure(error, io.env) ??
      (llmsg && error instanceof Error && 'code' in error && error.code === 'E_LLMSG_KEY'
        ? error.message
        : undefined)
    if (!message) throw error
    io.stderr.write(message + '\n')
    return 1
  }
}
