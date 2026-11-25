import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ToolRegistry } from '@agnes/core'
import { actor, fakeProvider, fakeSeams, openSession, textTurn, toolTurn } from '@agnes/core/testkit'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { expect, it, vi } from 'vitest'
import { createSessionQueryExtension, sessionEventReadTool, sessionRecallTool } from './index.js'
import { closeSessionQuery } from './runtime.js'

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
      for (const [i, body] of [
        'Site visit',
        'Mountain vegetation survey 山地植被调查',
        'Follow-up visit',
      ].entries())
        event.run(key, i + 1, key + i, JSON.stringify({ text: body }))
    }
    const registerHook = vi.fn((_event: string, _handler: () => unknown) => () => {})
    extensionFactoryOf(createSessionQueryExtension({ dataDir: dir }))({
      registerTool: () => () => {},
      registerHook,
      ctx: { log: {} },
    } as unknown as ExtensionAPI)
    const context = registerHook.mock.calls.find(([event]) => event === 'context')?.[1]
    expect(await context?.()).toMatchObject({
      sections: [
        {
          content: expect.stringMatching(
            /session_recall.*English or Chinese.*session_event_read.*exact literal phrases.*session_search.*session_event_search/,
          ),
        },
      ],
    })
    const ctx = { session: { key: 'caller', workspaceRoot: '/same' } } as ToolContext
    const english = text(
      await sessionRecallTool.execute({ query: 'What did we learn about vegetation?', limit: 4 }, ctx),
    )
    expect(english).toMatch(/session peer #2/)
    expect(english).not.toMatch(/session (?:caller|private|away)/)
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

    const registry = new ToolRegistry()
    // Make the installed tool available on the first turn of this fixture.
    registry.add(
      { ...sessionRecallTool, meta: { ...sessionRecallTool.meta, deferLoading: false } },
      {
        source: '@agnes/session-query',
        trust: 'builtin',
      },
    )
    const provider = fakeProvider([toolTurn('session_recall', { query: '植被' }), textTurn('done')])
    const seams = fakeSeams()
    const approval = vi.spyOn(seams.approval, 'ask')
    const { session, log } = await openSession({ provider, seams, registry, key: 'caller', cwd: '/same' })
    try {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'Recall vegetation' }], actor })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      expect(approval).not.toHaveBeenCalled()
      expect(await log.scan({ type: 'tool/result', toSeq: session.lastSeq })).toMatchObject([
        { trust: 'untrusted' },
      ])
      const result = provider.requests[1]?.messages.find((message) => message.role === 'tool_result')
      expect(result?.content).toMatchObject([
        {
          type: 'text',
          text: expect.stringMatching(
            /^<untrusted id="([^"]+)" bytes="\d+">[\s\S]*Mountain vegetation survey[\s\S]*<\/untrusted id="\1">$/,
          ),
        },
      ])
    } finally {
      await session.close()
    }
  } finally {
    closeSessionQuery()
    rmSync(dir, { recursive: true, force: true })
  }
})
