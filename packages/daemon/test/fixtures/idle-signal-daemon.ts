import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient, memoryJournal } from '@agnes/sdk'
import { runAgnesd, startProductionSupervisor } from '../../src/launch.js'
import { createIdleSignal } from '../../src/supervisor/managed-session-idle.js'

// The source daemon of `source-loop-daemon.ts`, with its idle signal recorded to a log file: one
// JSON line per idle report, and one when startup fires, after trying to open a session it names.
const home = process.argv[2]
const workspace = process.argv[3]
const log = process.argv[4]
const probe = process.argv[5]
if (!home || !workspace || !log || !probe) throw new Error('idle daemon fixture requires four arguments')

const record = (row: Record<string, unknown>) =>
  appendFileSync(log, `${JSON.stringify({ ...row, at: Date.now() })}\n`)
const idle = createIdleSignal()
let socketPath: string | undefined
idle.onIdle((sessionId) => record({ kind: 'idle', sessionId }))
idle.onStartup(async () => {
  const sessionId = existsSync(probe) ? readFileSync(probe, 'utf8').trim() : undefined
  try {
    if (!socketPath) throw new Error('startup before the supervisor was configured')
    const client = createClient({
      journal: memoryJournal(),
      auth: { kind: 'local' },
      transport: { kind: 'unix', path: socketPath },
    })
    try {
      await client.initialize()
      if (sessionId) await client.session.load(sessionId, { history: 'none' })
    } finally {
      await client.close()
    }
    record({ kind: 'startup', connected: true, ...(sessionId ? { opened: sessionId } : {}) })
  } catch (error) {
    record({ kind: 'startup', connected: false, error: String((error as Error)?.message ?? error) })
  }
})

await runAgnesd(
  { home, workspace, profile: 'local-dev' },
  {
    workerExecPath: process.execPath,
    workerExecArgv: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href],
    workerEntry: fileURLToPath(new URL('../../src/worker/main.ts', import.meta.url)),
    startProduction: (options, deps) => {
      socketPath = options.config.socketPath
      return startProductionSupervisor({ ...options, idleSignal: idle }, deps)
    },
  },
)
