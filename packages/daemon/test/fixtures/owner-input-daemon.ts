import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runAgnesd, startProductionSupervisor } from '../../src/launch.js'

// The source daemon of `source-loop-daemon.ts` with the local Web listener on, so a test can act as the
// owner's Web page, and with crash points inside owner input admission: when `<faults>/<point>` exists
// at that point, the file is removed and the daemon kills itself with SIGKILL, mid-request.
const home = process.argv[2]
const workspace = process.argv[3]
const faults = process.argv[4]
if (!home || !workspace || !faults) throw new Error('owner input daemon fixture requires three arguments')

const crashAt = (point: string) => () => {
  const marker = join(faults, point)
  if (!existsSync(marker)) return
  rmSync(marker)
  process.kill(process.pid, 'SIGKILL')
}

await runAgnesd(
  { home, workspace, profile: 'local-dev' },
  {
    workerExecPath: process.execPath,
    workerExecArgv: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href],
    workerEntry: fileURLToPath(new URL('../../src/worker/main.ts', import.meta.url)),
    localWeb: { addr: '127.0.0.1:0', origin: 'http://127.0.0.1:9' },
    startProduction: (options, deps) =>
      startProductionSupervisor(
        {
          ...options,
          ownerInputFaults: { afterReserve: crashAt('afterReserve'), afterSubmit: crashAt('afterSubmit') },
        },
        deps,
      ),
  },
)
