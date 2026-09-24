import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withConfigurationLock } from '../src/configuration-lock.js'

it('releases a configuration transaction after its owner process is killed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agnes-config-lock-'))
  const file = join(directory, 'lock.sqlite')
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.send('locked'); setInterval(()=>{},1000);`,
      file,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  )
  try {
    await once(child, 'message')
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    await expect(withConfigurationLock(file, async () => 'saved')).resolves.toBe('saved')
  } finally {
    child.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
}, 10000)
