import type { EventEnvelope } from '@agnes/protocol'
import { expect, it, onTestFailed } from 'vitest'
import { CALLER, judgmentDaemon, MODEL } from './helpers/daemon.js'

const data = (row: EventEnvelope) => row.data as Record<string, unknown>
it('installs the real tools, runs isolated synthetic loopback judgments, accounts and revokes', async () => {
  const started = performance.now()
  const stages: string[] = []
  const enter = (name: string) => stages.push(`${Math.round(performance.now() - started)}ms ${name}`)
  enter('fixture startup')
  onTestFailed(() => console.error(`Synthetic judgment tools fixture stages: ${stages.join(', ')}`))
  const fixture = await judgmentDaemon({ tools: true })
  try {
    enter('absent session')
    const absent = await fixture.session('tools-absent')
    expect((await absent.tools()).tools.map((tool) => tool.name)).not.toContain('judge_batch')
    enter('configure off')
    await fixture.configure({ judge: { route: 'jev-a', model: MODEL } })
    enter('disabled session')
    expect((await (await fixture.session('tools-off')).tools()).tools.map((tool) => tool.name)).not.toContain(
      'find_relevant',
    )
    enter('configure enabled')
    await fixture.configure({
      judge: { route: 'jev-a', model: MODEL },
      uses: { find: { enabled: true }, batch: { enabled: true } },
    })
    fixture.respond({}, 0.8)
    enter('enabled session')
    const session = await fixture.session('tools-enabled')
    enter('enabled tool catalog')
    const names = (await session.tools()).tools.map((tool) => tool.name)
    expect(names).toContain('find_relevant')
    expect(names).toContain('judge_batch')
    enter('tool turn')
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
    enter('revoke tools')
    await fixture.configure({ judge: { route: 'jev-a', model: MODEL } })
    enter('revoked session')
    const revoked = (await (await fixture.session('tools-revoked')).tools()).tools.map((tool) => tool.name)
    expect(revoked).not.toContain('find_relevant')
    expect(revoked).not.toContain('judge_batch')
  } catch (error) {
    throw new Error(`Synthetic judgment integration failed at ${stages.at(-1)}`, { cause: error })
  } finally {
    await fixture.close()
  }
  // The four pinned sessions and configuration publications run serially on real workers.
}, 420_000)
