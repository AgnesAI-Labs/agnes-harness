import { describe, expect, it } from 'vitest'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import { type VerifyInput, verifierT0 } from '../src/verifier.js'

const base: VerifyInput = {
  toolCalls: [],
  deviations: 0,
  recentToolKeys: [],
  surfaceTailHashes: [],
  newToolResults: 1,
}
const opts = { tier: 0 as const, signal: new AbortController().signal }
describe('verifier T0', () => {
  it('passes a clean input', async () => {
    const v = await verifierT0(fakeSeamInit())
    expect(await v.verify('turn', base, opts)).toEqual({ verdict: 'pass', reasons: [] })
  })
  it('fails on schema-invalid calls, tool-call-as-text and truncation on any scope', async () => {
    const v = await verifierT0(fakeSeamInit())
    expect(
      await v.verify('tool', { ...base, toolCalls: [{ name: 'x', args: {}, schemaOk: false }] }, opts),
    ).toEqual({ verdict: 'fail', reasons: ['schema_invalid'] })
    expect(await v.verify('step', { ...base, deviations: 2 }, opts)).toEqual({
      verdict: 'fail',
      reasons: ['tool_call_as_text'],
    })
    expect(await v.verify('step', { ...base, lastFinishReason: 'length' }, opts)).toEqual({
      verdict: 'fail',
      reasons: ['output_truncated'],
    })
  })
  it('flags repeats and no progress only on turn scope, honouring preset thresholds', async () => {
    const v = await verifierT0(
      fakeSeamInit({ preset: { loop: { repeat_threshold: 2, no_progress_steps: 2 } } }),
    )
    const rep = { ...base, recentToolKeys: ['edit|{"path":"a"}', 'edit|{"path":"a"}'] }
    expect(await v.verify('step', rep, opts)).toEqual({ verdict: 'pass', reasons: [] })
    expect(await v.verify('turn', rep, opts)).toEqual({
      verdict: 'needs_revision',
      reasons: ['repeated_write:2'],
    })
    expect(
      await v.verify('turn', { ...base, surfaceTailHashes: ['h', 'h'], newToolResults: 0 }, opts),
    ).toEqual({ verdict: 'needs_revision', reasons: ['no_progress:2'] })
  })
})
