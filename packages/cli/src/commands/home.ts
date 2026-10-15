import { agnesHome, homeVersionMessage, inspectHome } from '@agnes/host'
import type { MainIO } from '../bin.js'
import { startupFailure } from './first-run-locales.js'

export async function homeCommand(argv: readonly string[], io: MainIO): Promise<number> {
  if ((argv[0] ?? 'info') !== 'info' || argv.slice(1).some((flag) => flag !== '--json'))
    throw new Error('Usage: agh home info [--json]')
  try {
    const info = inspectHome(agnesHome(io.env), io.env.AGNES_PROFILE ?? 'local-dev')
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
    const message = startupFailure(error, io.env)
    if (!message) throw error
    io.stderr.write(message + '\n')
    return 1
  }
}
