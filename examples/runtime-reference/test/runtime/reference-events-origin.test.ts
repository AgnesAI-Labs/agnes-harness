import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CaseContext } from '@agnes/extension-api/testkit'
import { expect, it } from 'vitest'
import { referenceEventsPort } from '../../src/providers/events-contract.js'

it('refuses a revoked same-key replay without a physical write and reuses the original scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-events-origin-'))
  const path = join(directory, 'events.sqlite')
  const reference = referenceEventsPort(path)
  try {
    const normal = await reference.port.normal({} as CaseContext)
    expect(normal.revokedReplay).toMatchObject({ refused: 'permission_denied' })
    expect(normal.coveringReplay).toEqual(normal.refs[0])
    reference.close()
    const db = new DatabaseSync(path)
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 7 })
      expect(db.prepare('SELECT highwater FROM events_cursor_authority WHERE slot = 1').get()).toEqual({
        highwater: 7,
      })
      const original = db.prepare('SELECT record FROM events WHERE sequence = 1').get() as { record: string }
      expect(JSON.parse(original.record)).toMatchObject({
        event: { scope: { kind: 'session', sessionId: 'normal' } },
      })
    } finally {
      db.close()
    }
  } finally {
    reference.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
