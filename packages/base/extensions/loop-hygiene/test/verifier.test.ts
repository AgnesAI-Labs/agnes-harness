import { ToolRegistry } from '@agnes/core'
import {
  actor,
  fakeProvider,
  fakeSeams,
  openSession,
  readTool,
  textTurn,
  toolTurn,
} from '@agnes/core/testkit'
import type { ToolDef } from '@agnes/extension-api'
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
    for (const [readOnly, expected] of [
      [[true, true], 'pass'],
      [[false, false], 'needs_revision'],
      [[false, true], 'pass'],
      [[true, false], 'pass'],
      [[false, true, false], 'pass'],
      [[true, false, false], 'needs_revision'],
    ] as const) {
      const toolCalls = readOnly.map((isReadOnly) => ({
        name: 'edit',
        args: { path: 'a' },
        schemaOk: true,
        isReadOnly,
      }))
      expect(
        (
          await v.verify(
            'turn',
            { ...rep, toolCalls, recentToolKeys: toolCalls.map(() => rep.recentToolKeys[0]) },
            opts,
          )
        ).verdict,
      ).toBe(expected)
    }
    expect(
      await v.verify(
        'turn',
        {
          ...rep,
          toolCalls: [true, true].map((isReadOnly) => ({
            name: 'edit',
            args: { path: 'a' },
            schemaOk: true,
            isReadOnly,
          })),
          surfaceTailHashes: ['h', 'h'],
          newToolResults: 0,
        },
        opts,
      ),
    ).toEqual({ verdict: 'needs_revision', reasons: ['no_progress:2'] })
  })
})

// Use the actual Core projection and T0 seam together: a mock that passes on its second
// verification hides both the read-only false positive and the approval loop.
it.each([
  { readOnly: true, verdict: 'allowed-once', reason: 'completed' },
  { readOnly: false, verdict: 'allowed-once', reason: 'completed' },
  { readOnly: false, verdict: 'allowed-session', reason: 'completed' },
  { readOnly: false, verdict: 'rejected', reason: 'blocked' },
] as const)(
  'checks repeated calls and bounds $verdict to the current completion (readOnly=$readOnly)',
  async ({ readOnly, verdict, reason }) => {
    const registry = new ToolRegistry()
    const tool = readTool() as ToolDef
    registry.add(
      { ...tool, name: 'device', meta: { ...tool.meta, isReadOnly: readOnly } },
      { source: 's', trust: 'builtin' },
    )
    const round = [toolTurn('device', {}), toolTurn('device', {}), toolTurn('device', {}), textTurn('done')]
    const provider = fakeProvider([...round, ...round])
    let approvals = 0
    const { session, log } = await openSession({
      registry,
      provider,
      seams: fakeSeams({
        verifier: await verifierT0(fakeSeamInit()),
        repair: { decide: async () => 'park' },
        approval: { ask: async () => (++approvals === 1 ? verdict : 'rejected') },
      }),
    })
    const run = () => session.run({ until: 'turn-end', signal: new AbortController().signal })
    const enqueue = () => session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'check' }] })
    try {
      await enqueue()
      expect((await run()).reason).toBe(reason)
      expect(provider.calls).toBe(4)
      const asks = await log.scan({ type: 'approval/asked', limit: 100 })
      expect(asks).toHaveLength(readOnly ? 0 : 1)
      if (!readOnly) expect(asks[0]?.data).toMatchObject({ summary: 'verifier failed: repeated_write:3' })
      if (!readOnly && reason === 'completed') {
        // Even allowed-session does not waive a fresh set of repeated writes.
        await enqueue()
        expect((await run()).reason).toBe('blocked')
        expect(await log.scan({ type: 'approval/asked', limit: 100 })).toHaveLength(2)
        expect(await log.scan({ type: 'tool/call', limit: 100 })).toHaveLength(6)
      }
    } finally {
      await session.close()
    }
  },
)
