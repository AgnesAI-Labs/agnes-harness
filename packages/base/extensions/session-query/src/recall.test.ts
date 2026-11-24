import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { sessionEventReadTool, sessionRecallTool } from './index.js'
import { bindSessionQuery, closeSessionQuery } from './runtime.js'

function text(result: ToolResult): string {
  expect(result.isError).toBeUndefined()
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

it('uses an authorized recalled event as the center of an evidence window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-recall-'))
  try {
    using ledger = new DatabaseSync(join(dir, 'sessions.db'))
    ledger.exec(
      'CREATE TABLE events(session_key TEXT,seq INTEGER,ts TEXT,id TEXT,type TEXT,origin TEXT,trust TEXT,source_event_seqs TEXT,data TEXT)',
    )
    const event = ledger.prepare(
      "INSERT INTO events VALUES(?,?,'t',?,'user/message','user','untrusted',NULL,?)",
    )
    mkdirSync(join(dir, 'tables'))
    using side = new DatabaseSync(join(dir, 'tables', 'daemon.db'))
    side.exec(
      'CREATE TABLE session_workspaces(session_key TEXT,cwd TEXT); CREATE TABLE session_principal_ownership(session_id TEXT,principal_id TEXT)',
    )
    for (const key of ['caller', 'peer', 'private', 'away']) {
      side.prepare('INSERT INTO session_workspaces VALUES(?,?)').run(key, key === 'away' ? '/away' : '/same')
      side
        .prepare('INSERT INTO session_principal_ownership VALUES(?,?)')
        .run(key, key === 'private' ? 'other' : 'owner')
      for (const [i, body] of ['Site visit', '山地植被调查', 'Follow-up visit'].entries())
        event.run(key, i + 1, key + i, JSON.stringify({ text: body }))
    }
    bindSessionQuery(dir)
    const ctx = { session: { key: 'caller', workspaceRoot: '/same' } } as ToolContext
    const found = text(await sessionRecallTool.execute({ query: '植被', limit: 4 }, ctx))
    expect(found).not.toMatch(/session (?:caller|private|away)/)
    const hit = /session (\S+) #(\d+)/.exec(found)
    if (!hit?.[1]) throw new Error('Missing session and event sequence')
    expect(hit.slice(1)).toEqual(['peer', '2'])
    const evidence = text(
      await sessionEventReadTool.execute(
        { sessionId: hit[1], seq: Number(hit[2]), before: 1, after: 1 },
        ctx,
      ),
    )
    for (const phrase of ['植被', '#1 user/message Site visit', '#3 user/message Follow-up visit'])
      expect(evidence).toContain(phrase)
  } finally {
    closeSessionQuery()
    rmSync(dir, { recursive: true, force: true })
  }
})
