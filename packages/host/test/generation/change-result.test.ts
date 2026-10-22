import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SeamBinding } from '@agnes/host-providers/assemble/seam-rows'
import { afterEach, describe, expect, it } from 'vitest'
import { changeResult, seamChangesBetween } from '../../src/runtime/generation/change-result.js'
import { generationError, generationFailure } from '../../src/runtime/generation/failure.js'
import { createTestHost } from '../../testkit/index.js'

const bind = (kind: string, provider: string, version = '1.0.0'): SeamBinding => ({
  kind: kind as SeamBinding['kind'],
  provider,
  version,
  sourcePackage: '@agnes/base',
  integrity: 'sha-1',
})

describe('seam changes between containers', () => {
  const before = [bind('approval', 'a'), bind('verifier', 't0'), bind('billing', 'b')]
  const after = [bind('approval', 'a', '1.1.0'), bind('verifier', 'strict'), bind('billing', 'b')]

  it('says when each changed kind reaches sessions', () => {
    expect(seamChangesBetween(before, after, 'in-place').map(({ kind, effect }) => [kind, effect])).toEqual([
      ['approval', 'new-sessions'],
      ['verifier', 'applied'],
    ])
    expect(seamChangesBetween(before, after, 'forked').map(({ kind, effect }) => [kind, effect])).toEqual([
      ['approval', 'new-sessions'],
      ['verifier', 'new-sessions'],
    ])
    expect(seamChangesBetween(before, before, 'forked')).toEqual([])
  })

  it('carries a refusal as a result, with whether the previous state held', () => {
    const structured = generationFailure(
      Object.assign(new Error('E_LEASE_EXPIRED is diagnostic text'), {
        code: 'E_SEAM_INIT',
        detail: { reason: 'provider-unavailable' },
      }),
    )
    expect(structured).toMatchObject({ code: 'E_SEAM_INIT', reason: 'provider-unavailable' })
    expect(generationFailure(new Error('E_LEASE_EXPIRED is only text')).code).toBe('E_GENERATION')
    expect(generationFailure(generationError('E_GENERATION_INCOMPATIBLE', 'old deployment')).code).toBe(
      'E_GENERATION_INCOMPATIBLE',
    )

    const rejected = changeResult({
      outcome: 'rejected',
      generationId: 'g',
      restartRequired: ['adapter:storage'],
      failures: [{ stage: 'admission', code: 'E_GENERATION_RESTART_REQUIRED', message: 'restart' }],
      recovered: true,
    })
    expect(rejected).toMatchObject({
      outcome: 'rejected',
      recovered: true,
      restartRequired: ['adapter:storage'],
    })
    expect(changeResult({ outcome: 'forked', generationId: 'g', before, after }).seamChanges).toHaveLength(2)
  })
})

describe('a generation host reports what it did', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('reports an unchanged publish, the container’s bindings and a session’s binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-change-'))
    roots.push(root)
    const { host } = await createTestHost({ dataDir: root, disableSessionTitle: true })
    try {
      const session = await host.createSession({ key: 'bound', cwd: root })
      const target = host.runtimeTargetSnapshot?.()
      if (!target) throw new Error('runtime target expected')
      await host.applyRuntimeTarget(target)
      expect(host.lastChange?.()).toMatchObject({ outcome: 'unchanged', recovered: true, seamChanges: [] })

      const binding = host.sessionBinding?.('bound')
      expect(binding?.pinnedSeams.map((pin) => pin.kind)).toEqual([
        'approval',
        'principals',
        'billing',
        'checkpoint',
        'artifacts',
      ])
      const container = host.containerHandle?.(binding?.generationId as string)
      expect(container?.seams.map((seam) => seam.kind)).toEqual([
        'approval',
        'principals',
        'billing',
        'checkpoint',
        'artifacts',
        'verifier',
        'repair',
      ])
      await session.close()
    } finally {
      await host.close()
    }
  })
})
