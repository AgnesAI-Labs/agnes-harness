import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { Type } from '@sinclair/typebox'
import { expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, type Script, sent, textTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

// The question is asked and left open: the turn parks on it, and the person answers afterwards.
const call: Script = [
  sent(),
  {
    type: 'toolcall_end',
    call: { toolUseId: '', name: 'remote_action', args: { action: 'install' } as never, ordinal: 0 },
    via: 'native',
  },
  usage(),
  { type: 'done', reason: 'toolUse' },
]

function tools(counter: { runs: number }) {
  const registry = new ToolRegistry()
  registry.add(
    {
      name: 'remote_action',
      description: 'remote action',
      parameters: Type.Object({ action: Type.String() }),
      meta: {
        isReadOnly: false,
        isDestructive: false,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'never' as const,
        costHint: {},
        deferLoading: false,
        requiresApproval: 'never' as const,
      },
      execute: async () => {
        counter.runs++
        throw new Error('connection lost after send')
      },
    } as never,
    { source: 's', trust: 'builtin' },
  )
  return registry
}
const open = { approval: { ask: async () => ({ ticket: 'T1', expiresAt: '2099-01-01T00:00:00Z' }) } }
const run = (session: Awaited<ReturnType<typeof openSession>>['session']) =>
  session.run({ until: 'turn-end', signal: new AbortController().signal })

async function parked(counter: { runs: number }, storage = new MemoryStorage()) {
  const provider = fakeProvider([call, textTurn('carried on')])
  const h = await openSession({ storage, registry: tools(counter), seams: fakeSeams(open), provider })
  await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'install it' }] })
  expect((await run(h.session)).reason).toBe('parked')
  return { ...h, provider, storage }
}
async function answer(session: Awaited<ReturnType<typeof openSession>>['session'], option: string) {
  const question = (await session.decisions.list()).find(
    (value) => value.request.spec.purpose === 'unknown-outcome',
  )
  if (!question) throw new Error('missing reconciliation')
  await session.decisions.answer(
    {
      handle: question.handle,
      revision: question.revision,
      commandId: `late-${option}`,
      response: { option, value: null },
    },
    { actor, category: 'human', authorize() {} },
  )
  return question
}

it.each([
  ['allowed-session', 'The user confirmed that remote_action happened'],
  ['rejected', 'The user confirmed that remote_action did not happen'],
] as const)(
  'a late %s answer reopens the parked turn and the model reads the verdict',
  async (option, told) => {
    const counter = { runs: 0 }
    const h = await parked(counter)
    try {
      const question = await answer(h.session, option)
      expect((await run(h.session)).reason).toBe('completed')
      // The model was asked again, with the answer in front of it; the call itself never ran twice.
      expect(h.provider.calls).toBe(2)
      expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain(told)
      expect(counter.runs).toBe(1)
      const resumed = (await h.log.scan({ type: 'turn/start', order: 'desc', limit: 1 }))[0]?.data
      expect(resumed).toMatchObject({
        trigger: 'approval-resume',
        continues: { turn: 1, toolUseId: question.request.operationId, requestId: question.handle.id },
      })
      expect(
        (await h.session.decisions.list()).find((value) => value.handle.id === question.handle.id),
      ).toMatchObject({ result: { reason: 'answered' }, consumption: expect.any(Object) })
      // One conversation turn in the transcript: the continuation is the same turn, not a new one.
      expect((await h.session.projectUI()).turns).toHaveLength(1)
      const seq = h.log.lastSeq
      await run(h.session)
      expect(h.log.lastSeq).toBe(seq)
    } finally {
      await h.session.close()
    }
  },
)

it('after a cold restart, a late answer still reopens the parked turn exactly once', async () => {
  const counter = { runs: 0 }
  const h = await parked(counter)
  const rows = structuredClone(await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq, limit: 10_000 }))
  await h.session.close()
  const provider = fakeProvider([textTurn('carried on after restart')])
  const reopened = await openSession({
    storage: MemoryStorage.fromEvents('k', rows),
    registry: tools(counter),
    seams: fakeSeams(open),
    provider,
    writerRunId: 'after-restart',
  })
  try {
    await reopened.session.resume()
    await answer(reopened.session, 'allowed-once')
    expect((await run(reopened.session)).reason).toBe('completed')
    expect(provider.calls).toBe(1)
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain(
      'The user confirmed that remote_action happened',
    )
    expect(counter.runs).toBe(1)
    expect(
      (await reopened.log.scan({ type: 'turn/start', limit: 10 })).filter(
        (row) => (row.data as { trigger?: string }).trigger === 'approval-resume',
      ),
    ).toHaveLength(1)
  } finally {
    await reopened.session.close()
  }
})
