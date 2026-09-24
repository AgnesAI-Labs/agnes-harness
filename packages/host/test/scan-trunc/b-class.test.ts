import { applyRefine, rollbackRefine } from '@agnes/core'
import { actor, fakeProvider, textTurn, toolTurn } from '@agnes/core/testkit'
import { describe, expect, it } from 'vitest'
import { ledgerDir, longPreset, openOn, readRegistry } from './fixture.js'

type Provenance = { trust: 'trusted' | 'untrusted'; callSeq?: number }

/**
 * A finished turn with one real, trusted `read` call, followed by deferred-job markers written the
 * way the tools phase writes them. The provenance check reads the markers back; before the fix it
 * asked for pages of 1,000, got 500, and took the short page for the end of the ledger.
 */
async function withMarkers(
  prefix: string,
  layout: (match: () => object, other: (n: number) => object) => object[],
) {
  const ledger = ledgerDir(prefix)
  const storage = ledger.open()
  try {
    const provider = fakeProvider([toolTurn('read', {}), textTurn('done')])
    const { session } = await openOn(storage, { provider, registry: readRegistry(), preset: longPreset() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    const [call] = await session.scan({ type: 'tool/call', toSeq: session.lastSeq, limit: 1 })
    const toolUseId = String((call?.data as { toolUseId?: string } | undefined)?.toolUseId)
    const marker = (jobId: string) =>
      session.ev(
        'x/core/deferred-job',
        { jobId, toolUseId },
        { ignorable: true, sourceEventSeqs: [call?.seq ?? 0] },
      )
    const rows = layout(
      () => marker('job-1'),
      (n) => marker(`other-${n}`),
    )
    for (let i = 0; i < rows.length; i += 100) await session.append(rows.slice(i, i + 100) as never)
    const check = (session as unknown as { deferredResultProvenance(p: object): Promise<Provenance> })
      .deferredResultProvenance
    return { result: await check.call(session, { jobId: 'job-1', toolUseId }), callSeq: call?.seq }
  } finally {
    await storage.close()
    ledger.remove()
  }
}

describe('deferred result provenance over more than 500 markers', () => {
  it('finds the matching marker past the 500th', async () => {
    const { result, callSeq } = await withMarkers('scan-b1-late', (match, other) => [
      ...Array.from({ length: 600 }, (_, n) => other(n)),
      match(),
    ])
    expect(result).toEqual({ trust: 'trusted', callSeq })
  }, 60_000)

  it('sees a duplicate marker past the 500th and refuses to trust either', async () => {
    const { result } = await withMarkers('scan-b1-dup', (match, other) => [
      match(),
      ...Array.from({ length: 600 }, (_, n) => other(n)),
      match(),
    ])
    expect(result).toEqual({ trust: 'untrusted' })
  }, 60_000)
})

const SEP = String.fromCharCode(0)
const limits = {
  maxEntries: { prompt: 4, memory: 4, skill: 4, subagent: 4 },
  maxCharsPerEntry: 50,
  contractPrefixMarkers: [],
}
const entry = (id: string, content: string) => ({
  kind: 'memory' as const,
  id,
  title: 't',
  content,
  scope: 'local' as const,
  version: 1,
  source: 'refine',
})
const proposal = (edits: unknown[], baseline: Array<{ key: string; version: number }> = []) =>
  ({
    proposalId: 'p',
    trigger: 'manual' as const,
    edits,
    baseline,
    rationale: 'r',
    evidenceSeqs: [1],
  }) as never

it('rollback restores a value last written more than 500 entry rows earlier', async () => {
  const ledger = ledgerDir('scan-b4')
  const storage = ledger.open()
  try {
    const { session } = await openOn(storage, { provider: fakeProvider([]), preset: longPreset() })
    const m1 = `memory${SEP}m1`
    const m2 = `memory${SEP}m2`
    expect(
      (await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m1', 'orig') }]), limits)).outcome,
    ).toBe('applied')
    expect(
      (await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m2', 'v0') }]), limits)).outcome,
    ).toBe('applied')
    for (let v = 1; v <= 600; v++)
      await applyRefine(
        session,
        proposal([{ op: 'upsert', entry: entry('m2', `v${v}`) }], [{ key: m2, version: v }]),
        limits,
      )
    const change = await applyRefine(
      session,
      proposal([{ op: 'upsert', entry: entry('m1', 'changed') }], [{ key: m1, version: 1 }]),
      limits,
    )
    expect(change.outcome).toBe('applied')
    await rollbackRefine(session, change.seq)
    expect(session.latest('harness/entry', m1)).toMatchObject({ content: 'orig' })
  } finally {
    await storage.close()
    ledger.remove()
  }
}, 60_000)
