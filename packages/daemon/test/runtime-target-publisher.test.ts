import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { describe, expect, it, vi } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { publishProbedRuntimeTarget } from '../src/supervisor/publication/runtime-target-publisher.js'

const revision = 'd'.repeat(64)

function artifact(id: string) {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [
        createPluginRow({
          id,
          plugin: `builtin:host/${id}`,
          snapshotDigest: 'builtin:host:v1',
          exportName: id,
          entryRevision: 'host-row:v1',
          extrasRevision: 'none',
          mountRevision: 'host-row:v1',
        }),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    }),
  )
}

describe('publishProbedRuntimeTarget', () => {
  it('persists the probed artifact without rebuilding it', async () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const value = artifact('ext:live')
    const probe = vi.fn(async (probed: typeof value) => {
      expect(probed.digest).toBe(value.digest)
      expect(probed.canonicalBase64).toBe(value.canonicalBase64)
    })
    let accept!: () => void
    const acknowledgement = new Promise<void>((resolve) => {
      accept = resolve
    })
    let applying!: () => void
    const offered = new Promise<void>((resolve) => {
      applying = resolve
    })
    const publication = publishProbedRuntimeTarget({
      store,
      artifact: value,
      pins: ['tree:live'],
      probe,
      apply: async () => {
        applying()
        await acknowledgement
        return { generation: 3, report: { hash: value.identity.treeHash, ok: true, rows: [] } }
      },
    })
    await offered
    expect(store.desired()).toBeUndefined()
    expect(store.acknowledged()).toBeUndefined()
    accept()
    await publication
    expect(store.acknowledged()).toMatchObject({ digest: value.digest, generation: 3 })
    expect(probe).toHaveBeenCalledOnce()
    expect(store.desired()).toEqual(value)
    expect(store.pins()).toEqual([])
  })

  it.each(['probe', 'apply'] as const)('does not publish when %s fails', async (phase) => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    await expect(
      publishProbedRuntimeTarget({
        store,
        artifact: artifact('ext:fail'),
        probe: async () => {
          if (phase === 'probe') throw new Error('refused')
        },
        apply: async () => {
          throw new Error('refused')
        },
      }),
    ).rejects.toThrow('refused')
    expect(store.desired()).toBeUndefined()
  })

  it.each(['cas', 'generation', 'report', 'commit', 'qualify', 'restore'] as const)(
    'restores the authorized target when post-apply qualification changes (%s)',
    async (change) => {
      const tables = sqliteTables()
      try {
        const handle = tables.table('composite')
        const store = new CompositeTargetStore(handle, 'default')
        const prior = artifact('ext:prior')
        const next = artifact('ext:next')
        store.publishDesired(prior)
        let runtime = prior
        let restores = 0
        const exec = handle.exec.bind(handle)
        handle.exec = (sql, params = []) => {
          exec(sql, params)
          if (
            ((change === 'commit' || change === 'restore') && String(sql).includes('SET desired_json')) ||
            (change === 'qualify' && String(sql).includes('SET last_good_json'))
          )
            throw new Error('injected persistence failure')
        }
        await expect(
          publishProbedRuntimeTarget({
            store,
            artifact: next,
            probe: async () => {},
            apply: async () => {
              runtime = next
              if (change === 'cas') store.publishDesired(artifact('ext:intervening'))
              return {
                generation: 1,
                report: { hash: next.identity.treeHash, ok: change !== 'report', rows: [] },
                isCurrent: () => change !== 'generation',
                restore: async () => {
                  restores++
                  if (change === 'restore') throw new Error('injected restore failure')
                  runtime = prior
                },
              }
            },
          }),
        ).rejects.toThrow(
          change === 'cas'
            ? 'E_RUNTIME_TARGET_STALE'
            : change === 'commit' || change === 'qualify'
              ? 'injected persistence failure'
              : 'E_RUNTIME_TARGET_OUTCOME_UNKNOWN',
        )
        expect(restores).toBe(1)
        expect(runtime.digest).toBe(change === 'restore' ? next.digest : prior.digest)
        expect(store.desired()?.digest).not.toBe(next.digest)
        expect(store.lastGood()).toBeUndefined()
      } finally {
        await tables.close()
      }
    },
  )

  it('keeps one probed artifact and no ack without lastGood/report after a qualify crash', async () => {
    const tables = sqliteTables()
    const handle = tables.table('composite')
    const store = new CompositeTargetStore(handle, 'default')
    const value = artifact('ext:live')
    await publishProbedRuntimeTarget({
      store,
      artifact: value,
      probe: async (probed) => {
        expect(probed).toEqual(value)
      },
    })
    expect(store.desired()).toEqual(value)
    const exec = handle.exec.bind(handle)
    handle.exec = (sql, params = []) => {
      exec(sql, params)
      if (String(sql).includes('acknowledged_json')) throw new Error('injected crash after live failure')
    }
    expect(() =>
      store.qualifyConverged(1, value, { hash: value.identity.treeHash, ok: true, rows: [] }),
    ).toThrow('injected crash after live failure')
    expect(store.desired()).toEqual(value)
    expect(store.acknowledged()).toBeUndefined()
    expect(store.lastGood()).toBeUndefined()
    expect(store.report()).toBeUndefined()
  })
})

it.each(
  (['probe', 'apply', 'transaction'] as const).flatMap((boundary) =>
    (['epoch', 'deadline'] as const).map((loss) => ({ boundary, loss })),
  ),
)(
  'refuses activation after losing $loss at $boundary and restores its previous runtime',
  async ({ boundary, loss }) => {
    const tables = sqliteTables()
    try {
      const handle = tables.table('composite')
      const store = new CompositeTargetStore(handle, 'default')
      const prior = artifact('ext:prior'),
        next = artifact('ext:next')
      store.publishDesired(prior)
      let epoch = 1,
        now = 0,
        runtime = prior
      const expire = () => {
        if (loss === 'epoch') epoch++
        else now = 10
      }
      const assertActive = () => {
        if (epoch !== 1 || now >= 10) throw Error('permission unavailable')
      }
      const exec = handle.exec.bind(handle)
      handle.exec = (sql, params = []) => {
        exec(sql, params)
        if (boundary === 'transaction' && String(sql).includes('SET desired_json')) expire()
      }
      await expect(
        publishProbedRuntimeTarget({
          store,
          artifact: next,
          admission: { verify: async () => assertActive(), assertActive },
          probe: async () => {
            if (boundary === 'probe') expire()
          },
          apply: async () => {
            runtime = next
            if (boundary === 'apply') expire()
            return {
              generation: 1,
              report: { hash: next.identity.treeHash, ok: true, rows: [] },
              restore: async () => {
                runtime = prior
              },
            }
          },
        }),
      ).rejects.toThrow('permission unavailable')
      expect(runtime).toEqual(prior)
      expect(store.desired()).toEqual(prior)
      expect(store.lastGood()).toBeUndefined()
      expect(store.acknowledged()).toBeUndefined()
    } finally {
      await tables.close()
    }
  },
)

it.each(['revocation', 'abort', 'expiry', 'epoch', 'stale-proof'])(
  'shared proof: rolls back publication after %s inside final transaction',
  async (loss) => {
    const { permissionEffectAdmission } = await import('@agnes/protocol')
    let active = true,
      now = 0,
      epoch = 0,
      version = 1
    const controller = new AbortController()
    const proof = permissionEffectAdmission({
      signals: [controller.signal],
      expiresAt: 10,
      clock: () => now,
      unavailable: () => Error('permission unavailable'),
      assertBound: () => {
        if (!active || epoch !== 0 || version !== 1) throw Error('permission unavailable')
      },
    })
    const lose = () => {
      if (loss === 'revocation') active = false
      if (loss === 'abort') controller.abort()
      if (loss === 'expiry') now = 10
      if (loss === 'epoch') epoch++
      if (loss === 'stale-proof') version++
    }
    const tables = sqliteTables()
    const table = tables.table('composite')
    const store = new CompositeTargetStore(table, 'default')
    const prior = artifact('ext:prior'),
      next = artifact('ext:next')
    store.publishDesired(prior)
    const exec = table.exec.bind(table)
    table.exec = (sql, params = []) => {
      exec(sql, params)
      if (String(sql).includes('SET desired_json')) lose()
    }
    try {
      await expect(
        publishProbedRuntimeTarget({
          store,
          artifact: next,
          admission: proof,
          probe: async () => {},
        }),
      ).rejects.toThrow('permission unavailable')
      expect(store.desired()).toEqual(prior)
      expect(store.previous()).toBeUndefined()
      expect(store.acknowledged()).toBeUndefined()
    } finally {
      await tables.close()
    }
  },
)
