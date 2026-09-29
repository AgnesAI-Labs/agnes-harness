import { createAuxiliaryVisionEffectPort, type ScanQuery } from '@agnes/core'
import { actor, fakeProvider, toolTurn } from '@agnes/core/testkit'
import { expect, it } from 'vitest'
import { counted, ledgerDir, longPreset, openOn, readRegistry } from './fixture.js'

const meta = { source: 'agnes/scan-test', trust: 'trusted' as const }
const EXT = 'x/agnes/scan-test/note'

it('extension events past the 500th row of a turn still count toward the per-turn quota', async () => {
  const ledger = ledgerDir('scan-ext-quota')
  const { storage, scans } = counted(ledger.open())
  try {
    const provider = fakeProvider([toolTurn('read', {})])
    const { session } = await openOn(storage, { provider, registry: readRegistry(), preset: longPreset() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await session.step()
    const trigger = (
      await session.scan({ type: 'user/message', toSeq: session.lastSeq, order: 'desc', limit: 1 })
    )[0]?.seq as number
    // Tool steps until the turn is past 600 rows, so every extension row lands beyond the first page.
    while (session.lastSeq - trigger < 600) await session.step()
    const quota = session.preset.ext.eventsPerTurn

    scans.length = 0
    const before = session.lastSeq
    await session.appendExtensionEvent(EXT, { n: 0 }, meta)
    const rows = session.lastSeq - 1 - trigger + 1
    const underQuota = scans.splice(0)
    await session.appendExtensionEvent(EXT, { n: 1 }, meta)
    const next = scans.splice(0)

    for (let n = 2; n < quota; n++) await session.appendExtensionEvent(EXT, { n }, meta)
    scans.length = 0
    await expect(session.appendExtensionEvent(EXT, { n: quota }, meta)).rejects.toThrow('quota exceeded')
    const overQuota = scans.splice(0)
    expect(await session.scan({ type: EXT, toSeq: session.lastSeq, limit: 500 })).toHaveLength(quota)

    // Under quota: every page of the turn once, then the trigger row by itself.
    expect(underQuota).toHaveLength(Math.ceil(rows / 500) + 1)
    expect(underQuota.at(-1)?.q).toMatchObject({ fromSeq: trigger, toSeq: trigger, limit: 1 })
    // The next call counts only what was appended since (here the one event the first call wrote),
    // not the whole turn again.
    expect(next.map((s) => s.q)).toEqual([
      { fromSeq: before + 1, toSeq: before + 1, lane: 'main', limit: 500 },
      { fromSeq: trigger, toSeq: trigger, lane: 'main', limit: 1 },
    ])
    // Over quota: it stops on the page where the count is reached and never reads the trigger row.
    expect(overQuota.length).toBeLessThanOrEqual(Math.ceil((session.lastSeq - trigger + 1) / 500))
    expect(overQuota.some((s) => s.q.fromSeq === trigger && s.q.toSeq === trigger)).toBe(false)
    expect([...underQuota, ...overQuota].every((s) => (s.q as ScanQuery).limit !== undefined)).toBe(true)
  } finally {
    await storage.close()
    ledger.remove()
  }
}, 120_000)

it('a turn whose extension events came early stops reading at the page that reaches the quota', async () => {
  const ledger = ledgerDir('scan-ext-early')
  const { storage, scans } = counted(ledger.open())
  try {
    const provider = fakeProvider([toolTurn('read', {})])
    const { session } = await openOn(storage, { provider, registry: readRegistry(), preset: longPreset() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await session.step()
    const quota = session.preset.ext.eventsPerTurn
    for (let n = 0; n < quota; n++) await session.appendExtensionEvent(EXT, { n }, meta)
    const last = (await session.scan({ type: EXT, toSeq: session.lastSeq, order: 'desc', limit: 1 }))[0]
      ?.seq as number
    while (session.lastSeq - last < 1_000) await session.step()
    scans.length = 0
    await expect(session.appendExtensionEvent(EXT, { n: quota }, meta)).rejects.toThrow('quota exceeded')
    // Everything up to the last event was counted by the calls before; the new stretch starts with
    // that event, which reaches the quota inside its first page. The rest of the turn is never read.
    expect(scans.map((s) => s.q)).toEqual([
      { fromSeq: last, toSeq: session.lastSeq, lane: 'main', limit: 500 },
    ])
  } finally {
    await storage.close()
    ledger.remove()
  }
}, 120_000)

const hash = (digit: string) => digit.repeat(64)
const terminal = {
  kind: 'known_spend' as const,
  outcome: 'ok' as const,
  purpose: 'media' as const,
  model: 'vision-model',
  interrupted: false,
  tokens: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0 },
  credits: 0.25,
  creditSource: 'gateway' as const,
  visionText: 'Save is visible',
}

it('an auxiliary vision effect is found after 1,250 earlier effect rows', async () => {
  const ledger = ledgerDir('scan-aux-vision')
  const { storage, scans } = counted(ledger.open())
  try {
    const { session } = await openOn(storage, { provider: fakeProvider([]), preset: longPreset() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'inspect' }], actor })
    expect(await session.acceptInput()).toBe(true)
    const port = createAuxiliaryVisionEffectPort(session as never)
    const binding = (n: number) => ({
      effectId: `aux:${n}`,
      sessionKey: session.key,
      lane: 'main',
      auditBindingHash: hash('a'),
      budgetBindingHash: hash('b'),
      mediaManifestHash: hash('c'),
      requestDerivedHash: hash('d'),
      model: 'vision-model',
    })
    // Each finished effect writes five rows the port reads back: intent, its metadata, the
    // settlement, its metadata, and the cost row. 250 of them put 1,250 matching rows first.
    const EARLIER = 250
    for (let n = 0; n < EARLIER; n++) {
      await port.begin(binding(n))
      await port.finish(binding(n), terminal)
    }
    const target = binding(EARLIER)
    expect((await port.begin(target)).status).toBe('admitted')
    const finished = await port.finish(target, terminal)
    expect(finished.status).toBe('finished')
    scans.length = 0
    await expect(port.begin(target)).resolves.toEqual(finished)
    const inspecting = scans.filter((s) => Array.isArray(s.q.type) && s.q.type.includes('cost/ledger'))
    const matching = (EARLIER + 1) * 5
    expect(inspecting).toHaveLength(Math.floor(matching / 500) + 1)
    expect(
      await session.scan({ type: 'effect/intent', fromSeq: 1, toSeq: session.lastSeq, limit: 500 }),
    ).toHaveLength(EARLIER + 1)
  } finally {
    await storage.close()
    ledger.remove()
  }
}, 120_000)
