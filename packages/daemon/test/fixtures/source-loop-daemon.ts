import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runAgnesd } from '../../src/launch.js'

const home = process.argv[2]
const workspace = process.argv[3]
if (!home || !workspace) throw new Error('source daemon fixture requires home and workspace')

await runAgnesd(
  { home, workspace, profile: 'local-dev' },
  {
    workerExecPath: process.execPath,
    workerExecArgv: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href],
    workerEntry: fileURLToPath(new URL('../../src/worker/main.ts', import.meta.url)),
  },
)
