import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ev } from '../../../host/test/adapters/events.js'
import { createSqliteStorage, ownerFile } from '../../src/adapters/storage-sqlite.js'

// The existing real-process ledger lock case belongs in the heavy tier. Owned tables must obey
// the same contract: a daemon and worker legitimately write the same jobs/schedules database.
it.each(['ledger', 'owned table'] as const)(
  'waits for another process holding the %s write lock',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-storage-lock-'))
    const storage = createSqliteStorage({ file: join(root, 'sessions.db') })
    const table = storage.tables('@agnes/daemon').table('fixture')
    table.exec('CREATE TABLE fixture (v INTEGER)')
    await storage.open('session', { writerRunId: 'writer', ttlMs: 5000 })
    const file =
      kind === 'ledger' ? join(root, 'sessions.db') : join(root, 'tables', `${ownerFile('@agnes/daemon')}.db`)
    const child = spawn(process.execPath, [
      '-e',
      `
    const db = new (require('node:sqlite').DatabaseSync)(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    if (process.argv[2] === 'owned table') db.exec('INSERT INTO fixture VALUES (7)');
    process.stdout.write('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close() }, 200);
  `,
      file,
      kind,
    ])
    const exited = once(child, 'exit')
    try {
      await once(child.stdout, 'data')
      if (kind === 'ledger') {
        expect(
          await storage.commit('session', {
            events: [ev('user/message', {})],
            expectedWriterRunId: 'writer',
          }),
        ).toEqual({ firstSeq: 1, seqs: [1] })
      } else {
        table.transaction(() => table.run('INSERT INTO fixture VALUES (?)', [8]))
        expect(table.all('SELECT v FROM fixture ORDER BY v')).toEqual([{ v: 7 }, { v: 8 }])
      }
      expect(await exited).toEqual([0, null])
    } finally {
      if (child.exitCode === null) child.kill()
      await exited
      await storage.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
