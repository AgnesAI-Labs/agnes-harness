import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InferenceEvent } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { baseSeamFactories, createTestHost, runOnce } from '../testkit/index.js'

/**
 * core's four verify call sites against the real `verifierT0` from @agnes/base — not a fake. The
 * seam blind-casts core's `input` into its own VerifyInput, so the contract can only be pinned
 * end-to-end: a clean turn must come back `pass`, and calls without trusted policy retain conservative repeat detection, with no 'verifier unavailable' anywhere.
 */
const say = (text: string): InferenceEvent[] => [
  { type: 'text_delta', delta: text },
  { type: 'done', reason: 'stop' },
]
const callRead = (): InferenceEvent[] => [
  {
    type: 'toolcall_end',
    call: { toolUseId: '', name: 'read', args: { path: 'note.txt' }, ordinal: 0 },
    via: 'native',
  },
  { type: 'done', reason: 'toolUse' },
]

type Signal = { scope?: unknown; verdict?: unknown; reasons?: unknown }
const signalsOf = (events: Array<{ type: string; data: unknown }>): Signal[] =>
  events.filter((e) => e.type === 'verifier/signal').map((e) => e.data as Signal)

describe('verifierT0 against real core verify inputs', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'agnes-vt0-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('a clean turn verifies pass and completes, with no verifier-unavailable failure', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({
      dataDir,
      script: [say('clean answer')],
      packages: { '@agnes/base': { seams: { verifier: baseSeamFactories.verifier } } },
    })
    try {
      const r = await runOnce(host, { prompt: 'hi', cwd: dataDir })
      expect(r.reason).toBe('completed')
      const signals = signalsOf(r.events)
      expect(signals).toHaveLength(1)
      expect(signals[0]).toMatchObject({ scope: 'turn', verdict: 'pass', reasons: [] })
    } finally {
      await host.close()
    }
  })

  it('calls without persisted policy retain repeat detection and honor explicit completion', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({
      dataDir,
      script: [callRead(), callRead(), callRead(), say('gave up')],
      // This minimal Host fixture registers no read tool: no trusted read-only policy is available.
      seams: { repair: { decide: async () => 'complete' } },
      packages: { '@agnes/base': { seams: { verifier: baseSeamFactories.verifier } } },
    })
    try {
      const r = await runOnce(host, { prompt: 'hi', cwd: dataDir })
      expect(r.reason).toBe('completed')
      const signals = signalsOf(r.events)
      expect(signals.every((s) => !(s.reasons as string[]).includes('verifier unavailable'))).toBe(true)
      const stepSignals = signals.filter((s) => s.scope === 'step')
      expect(stepSignals).toHaveLength(3)
      for (const s of stepSignals) expect(s).toMatchObject({ verdict: 'pass', reasons: [] })
      expect(
        r.events
          .filter((e) => e.type === 'tool/call')
          .map((e) => (e.data as { resolvedPolicy?: unknown }).resolvedPolicy),
      ).toEqual([undefined, undefined, undefined])
      expect(r.events.find((e) => e.type === 'x/core/verifier-recovery')?.data).toMatchObject({
        handling: 'complete',
        verdict: { verdict: 'needs_revision' },
      })
      const turnSignals = signals.filter((s) => s.scope === 'turn')
      expect(turnSignals.at(-1)).toMatchObject({
        verdict: 'needs_revision',
        reasons: ['repeated_write:3'],
      })
    } finally {
      await host.close()
    }
  })
})
