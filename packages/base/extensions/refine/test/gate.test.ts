import type { HarnessEntry, RefineProposal } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { gateT0, type RefineGateLimits } from '../src/gate.js'

const entry = (id: string, content = 'c', kind: HarnessEntry['kind'] = 'memory'): HarnessEntry => ({
  kind,
  id,
  title: 't',
  content,
  scope: 'local',
  version: 1,
  source: 'test',
})
const proposal = (over: Partial<RefineProposal> = {}): RefineProposal => ({
  proposalId: 'p1',
  trigger: 'auto',
  edits: [{ op: 'upsert', entry: entry('m1') }],
  baseline: [],
  rationale: 'r',
  evidenceSeqs: [1],
  ...over,
})
const limits: RefineGateLimits = {
  maxEntries: { prompt: 10, memory: 1, skill: 30, subagent: 10 },
  maxCharsPerEntry: 5,
  contractPrefixHash: 'contract-hash',
}

describe('gateT0', () => {
  it('accepts a bounded, evidenced proposal', () => {
    expect(gateT0(proposal(), limits, [])).toEqual({ ok: true })
  })

  it('rejects empty evidence, long content, and protected contract content', () => {
    expect(gateT0(proposal({ evidenceSeqs: [] }), limits, [])).toEqual({ ok: false, reason: 'no_evidence' })
    expect(
      gateT0(proposal({ edits: [{ op: 'upsert', entry: entry('m1', 'too-long') }] }), limits, []),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('max_chars_per_entry') })
    expect(
      gateT0(
        proposal({ edits: [{ op: 'upsert', entry: entry('m1', '<contract') }] }),
        { ...limits, maxCharsPerEntry: 50 },
        [],
      ),
    ).toEqual({ ok: false, reason: 'contract_prefix' })
    expect(
      gateT0(
        proposal({ edits: [{ op: 'upsert', entry: entry('m1', 'contract-hash') }] }),
        { ...limits, maxCharsPerEntry: 50 },
        [],
      ),
    ).toEqual({ ok: false, reason: 'contract_prefix' })
  })

  it('simulates the ordered edit set before enforcing per-kind caps', () => {
    const current = [entry('old')]
    expect(gateT0(proposal({ edits: [{ op: 'upsert', entry: entry('new') }] }), limits, current)).toEqual({
      ok: false,
      reason: 'max_entries memory',
    })
    expect(
      gateT0(
        proposal({
          edits: [
            { op: 'delete', kind: 'memory', id: 'old' },
            { op: 'upsert', entry: entry('new') },
          ],
        }),
        limits,
        current,
      ),
    ).toEqual({ ok: true })
    expect(
      gateT0(
        proposal({
          edits: [
            { op: 'upsert', entry: entry('new') },
            { op: 'upsert', entry: entry('new', 'v2') },
          ],
        }),
        limits,
        [],
      ),
    ).toEqual({ ok: true })
  })

  it('does not treat an empty optional contract hash as a universal match', () => {
    expect(gateT0(proposal(), { ...limits, contractPrefixHash: '' }, [])).toEqual({ ok: true })
  })

  it('fails closed for a corrupt durable edit with an unknown kind', () => {
    const corrupt = proposal({ edits: [{ op: 'delete', kind: 'other', id: 'x' } as never] })
    expect(gateT0(corrupt, limits, [])).toEqual({ ok: false, reason: 'unknown_kind other' })
  })
})
