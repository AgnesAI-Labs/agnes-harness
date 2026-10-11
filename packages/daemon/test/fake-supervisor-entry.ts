// A real supervisor process with synthetic worker/model resources and durable SQLite authority.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedProfile } from '@agnes/host'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import type { DaemonConfig } from '../src/supervisor/config.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'

const dir = process.argv[2]
if (!dir) throw new Error('synthetic supervisor needs an isolated directory')
const profileFile = join(dir, 'profile.json')
const profile = JSON.parse(readFileSync(profileFile, 'utf8')) as ResolvedProfile
const tables = sqliteTables(join(dir, 'daemon-tables.db'))
const supervisor = await startSupervisor({
  config: JSON.parse(readFileSync(join(dir, 'daemon-config.json'), 'utf8')) as DaemonConfig,
  profile,
  profileDir: join(dir, 'profiles', 'local-dev'),
  profileFile,
  workspaceRoot: dir,
  jobTables: tables,
  workerExecPath: process.execPath,
  workerEntry: fileURLToPath(new URL('./fake-worker-entry.ts', import.meta.url)),
  workerExecArgv: ['--import', 'tsx'],
})
process.stdout.write(`READY_SOCKET ${supervisor.socketPath}\n`)
let closing = false
process.on('SIGTERM', () => {
  if (closing) return
  closing = true
  void (async () => {
    await supervisor.close()
    await tables.close()
    process.exit(0)
  })()
})
