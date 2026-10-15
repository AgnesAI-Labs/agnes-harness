import { fakeProvider, openSession, textTurn } from '@agnes/core/testkit'
import type { Host, HostSession } from '@agnes/host'
import { expect, it } from 'vitest'
import { handleCommand } from '../src/commands.js'

it('atomically deduplicates bound inputs on the original lane across worker restart', async () => {
  const first = await openSession({ provider: fakeProvider([textTurn('Accepted')]) })
  let session = first.session
  const host = { profile: { hash: 'profile' }, sessionGeneration: () => 'gen-one' } as unknown as Host
  const frame = {
    kind: 'command' as const,
    requestId: 'delivery',
    method: 'deliverSystemInput' as const,
    params: {
      commandId: 'wake:stable',
      laneId: 'main',
      generationId: 'gen-one',
      targetActorId: session.d.actor.id,
      targetActorOrg: session.d.actor.org,
      actor: { id: 'plugin/report', org: 'local', role: 'extension', deptPath: [], attrs: {} },
      system: {
        source: 'plugin/report',
        type: 'report.done',
        data: { result: 'done' },
        summary: 'Synthetic report finished',
      },
    },
  }
  const deliver = (params = frame.params) =>
    handleCommand(session as HostSession, { ...frame, params }, { host, aborts: new Map() })
  try {
    const sequences = await Promise.all([deliver(), deliver()])
    expect(sequences[0]).toBe(sequences[1])
    expect(session.latest('inbox')).toMatchObject({
      items: [{ commandId: 'wake:stable', origin: 'system', trust: 'untrusted' }],
    })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    await session.close()
    const second = await openSession({
      provider: fakeProvider([]),
      storage: first.storage,
      key: session.key,
      writerRunId: 'wake-restart',
    })
    session = second.session
    expect(await deliver()).toBe(sequences[0])
    await expect(deliver({ ...frame.params, laneId: 'missing-lane' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(deliver({ ...frame.params, generationId: 'other-generation' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(deliver({ ...frame.params, targetActorOrg: 'another-org' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    const inputs = await session.scan({ type: 'user/message', limit: 100 })
    expect(
      inputs.filter(
        (event) => (event.data as { system?: { source: string } }).system?.source === 'plugin/report',
      ),
    ).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ origin: 'system', trust: 'untrusted', lane: 'main' })
  } finally {
    await session.close()
  }
})
