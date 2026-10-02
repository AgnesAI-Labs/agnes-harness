import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { measureApprovalCommitIncrement } from './runtime-approval-commit-count.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function sample(states: number, auxiliary: number, notices = states + auxiliary) {
  const root = mkdtempSync(join(tmpdir(), 'approval-count-'))
  roots.push(root)
  const file = join(root, 'actual.sqlite'),
    db = new DatabaseSync(file)
  try {
    db.exec(
      'CREATE TABLE events(type TEXT NOT NULL); CREATE TABLE runtime_aux_commits(token TEXT PRIMARY KEY)',
    )
    for (let index = 0; index < states; index++) {
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO events VALUES (?)').run('runtime/state-commit')
      db.exec('COMMIT')
    }
    for (let index = 0; index < auxiliary; index++) {
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO runtime_aux_commits VALUES (?)').run(String(index))
      db.exec('COMMIT')
    }
  } finally {
    db.close()
  }
  return { file, commits: Array.from({ length: notices }, () => ({ wrote: true })) }
}
describe('approval authoritative counter driver, not a measured approval scenario', () => {
  it('counts same-transaction State writes and separate auxiliary commits from real SQLite', async () => {
    const baseline = sample(4, 1),
      approval = sample(5, 2)
    await expect(
      measureApprovalCommitIncrement(async (name) => (name === 'k1' ? baseline : approval)),
    ).resolves.toEqual({ k1: 5, approvalK1: 7, increment: 2 })
  })
  it('does not omit an extra journal/claim/ack commit from the always-blocking limit', async () => {
    const baseline = sample(4, 1),
      approval = sample(5, 3)
    await expect(
      measureApprovalCommitIncrement(async (name) => (name === 'k1' ? baseline : approval)),
    ).rejects.toThrow('increment 3')
  })
  it('refuses persisted writes missing from the observed authority notices', async () => {
    const baseline = sample(4, 1),
      approval = sample(5, 3, 7)
    await expect(
      measureApprovalCommitIncrement(async (name) => (name === 'k1' ? baseline : approval)),
    ).rejects.toThrow('does not match attested')
  })
})
