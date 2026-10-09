import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// These tests remain a merge gate after their filename moves them to the proper heavy tier.
const files = Object.keys(JSON.parse(readFileSync(new URL('./heavy-migrations.json', import.meta.url))))
const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'vitest', 'run', '--project', 'heavy', '--maxWorkers=1', ...process.argv.slice(2), ...files],
  { stdio: 'inherit' },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
