import type { EventEnvelope } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { CALLER, judgmentDaemon, MODEL } from './helpers/daemon.js'

const data = (row: EventEnvelope) => row.data as Record<string, unknown>
it('installs the real tools, runs isolated synthetic loopback judgments, accounts and revokes', async () => {
  const fixture = await judgmentDaemon({ tools: true })
  let stage = 'absent session'
  try {
    const absent = await fixture.session('tools-absent')
    expect((await absent.tools()).tools.map((tool) => tool.name)).not.toContain('judge_batch')
    stage = 'configure off'
    await fixture.configure({ judge: { route: 'jev-a', model: MODEL } })
    expect((await (await fixture.session('tools-off')).tools()).tools.map((tool) => tool.name)).not.toContain(
      'find_relevant',
    )
    stage = 'configure enabled'
    await fixture.configure({
      judge: { route: 'jev-a', model: MODEL },
      uses: { find: { enabled: true }, batch: { enabled: true } },
    })
    fixture.respond({}, 0.8)
    stage = 'enabled session'
    const session = await fixture.session('tools-enabled')
    const names = (await session.tools()).tools.map((tool) => tool.name)
    expect(names).toContain('find_relevant')
    expect(names).toContain('judge_batch')
    stage = 'tool turn'
    const turn = await fixture.turn(session, 'Use the synthetic judgment tools.')
    const diagnosticResults = turn.events.filter((row) => row.type === 'tool/result').map(data)
    expect(
      diagnosticResults.map((row) => row.isError),
      JSON.stringify(diagnosticResults),
    ).toEqual([false, false])
    const intents = turn.events.filter(
      (row) =>
        row.type === 'x/core/side-call-intent' && (data(row).audit as { caller?: string })?.caller === CALLER,
    )
    expect(intents.map((row) => (data(row).audit as { label: string }).label)).toEqual([
      'judgment.find.names',
      'judgment.find.sketches',
      'judgment.find.verify',
      'judgment.batch',
    ])
    const results = turn.events.filter((row) => row.type === 'tool/result').map(data)
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      isError: false,
      structured: { filesJudged: 1, matches: [{ startLine: 1, endLine: 1, score: 0.8 }] },
    })
    expect(results[1]).toMatchObject({
      isError: false,
      structured: { completed: [{ id: 'sample', needsReview: false }], pending: [], partial: false },
    })
    expect(fixture.fake.seen).toHaveLength(4)
    expect(JSON.stringify(fixture.fake.seen)).not.toContain('fixture-pass')
    const costs = turn.events.filter((row) => row.type === 'cost/ledger' && data(row).caller === CALLER)
    expect(costs).toHaveLength(4)
    expect(costs.every((row) => data(row).purpose === 'side-call' && data(row).route === 'jev-a')).toBe(true)
    await fixture.configure({ judge: { route: 'jev-a', model: MODEL } })
    const revoked = (await (await fixture.session('tools-revoked')).tools()).tools.map((tool) => tool.name)
    expect(revoked).not.toContain('find_relevant')
    expect(revoked).not.toContain('judge_batch')
  } catch (error) {
    throw new Error(`Synthetic judgment integration failed at ${stage}`, { cause: error })
  } finally {
    await fixture.close()
  }
}, 240000)
