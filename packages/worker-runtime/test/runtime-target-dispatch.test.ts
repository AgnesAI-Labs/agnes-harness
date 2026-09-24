import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import {
  buildRuntimeTarget,
  createPluginRow,
  encodeRuntimeTargetArtifact,
  RESOURCE_OWNED_ROW_IDS,
  type RuntimeConvergenceReport,
  type RuntimeTarget,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeFrame } from '../src/framing.js'
import { runWorker, type WorkerHostLike } from '../src/main.js'

const roots: string[] = []
const links: Duplex[] = []

afterEach(async () => {
  for (const link of links.splice(0)) {
    link.removeAllListeners()
    link.destroy()
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

function artifact(revision: string): RuntimeTargetArtifact {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [],
      resourceRevision: revision.repeat(64),
      compositeRevision: revision.repeat(64),
      resources: { mcp: [], skills: {} },
    }),
  )
}

function stale(value: RuntimeTargetArtifact) {
  return { type: 'runtime.stale', artifact: structuredClone(value) } as const
}

function report(target: RuntimeTarget): RuntimeConvergenceReport {
  return { hash: target.tree.hash, ok: true, rows: [] }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

async function fixture(
  applyRuntimeTarget: WorkerHostLike['applyRuntimeTarget'],
  env: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'agnes-runtime-target-dispatch-'))
  roots.push(root)
  const profileFile = join(root, 'profile.json')
  await writeFile(
    profileFile,
    JSON.stringify({
      name: 'local-dev',
      dataDir: root,
      cacheDir: root,
      packages: [],
      adapters: { secrets: { kind: 'env' } },
      hash: `sha256-${'0'.repeat(64)}`,
    }),
  )
  const written: unknown[] = []
  const link = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split('\n').filter(Boolean)) written.push(JSON.parse(line))
      callback()
    },
  })
  links.push(link)
  const host = {
    applyRuntimeTarget,
    close: vi.fn(async () => undefined),
    createSession: vi.fn(),
    acceptWorkspaceBinding: vi.fn(),
  } as unknown as WorkerHostLike
  await runWorker(
    {
      AGNES_WORKER_TOKEN: 'token',
      AGNES_SUPERVISOR_SOCKET: '/tmp/agnes-runtime-target-dispatch.sock',
      AGNES_WORKER_KEY: '@shared',
      AGNES_WORKER_KIND: 'session',
      AGNES_WORKER_GENERATION: '1',
      AGNES_PROFILE_FILE: profileFile,
      AGH_HOME: root,
      HOME: root,
      ...env,
    },
    { connect: async () => link, gate: null },
    { buildHost: async () => host },
  )
  return { link, written }
}

describe('runWorker runtime.stale production dispatch', () => {
  it('verifies complete frames and applies only the latest queued target through one Host slot', async () => {
    const first = deferred<void>()
    const calls: RuntimeTarget[] = []
    const applyRuntimeTarget = vi.fn(async (target: RuntimeTarget) => {
      calls.push(target)
      if (calls.length === 1) await first.promise
      return report(target)
    })
    const { link } = await fixture(applyRuntimeTarget)
    const a = artifact('a')
    const b = artifact('b')
    const c = artifact('c')

    link.push(Buffer.from([encodeFrame(stale(a)), encodeFrame(stale(b)), encodeFrame(stale(c))].join('')))

    await expect.poll(() => calls.length).toBe(1)
    first.resolve()
    await expect.poll(() => calls.length).toBe(2)
    expect(calls.map((target) => target.resource.target.compositeRevision)).toEqual([
      a.identity.compositeRevision,
      c.identity.compositeRevision,
    ])
  })

  it('keeps a failed digest retryable and does not route legacy kind/method frames into the target slot', async () => {
    const failure = new Error('candidate rejected')
    const applyRuntimeTarget = vi
      .fn<(target: RuntimeTarget) => Promise<RuntimeConvergenceReport>>()
      .mockRejectedValueOnce(failure)
      .mockImplementation(async (target) => report(target))
    const { link } = await fixture(applyRuntimeTarget)
    const a = artifact('a')

    link.push(
      Buffer.from(
        [
          encodeFrame({ kind: 'runtime.stale', requestId: 'wrong-kind', artifact: a }),
          encodeFrame({ kind: 'command', requestId: 'legacy', method: 'resource.stale', params: {} }),
          encodeFrame(stale(a)),
        ].join(''),
      ),
    )

    await expect.poll(() => applyRuntimeTarget.mock.calls.length).toBe(1)
    link.push(Buffer.from(encodeFrame(stale(a))))
    await expect.poll(() => applyRuntimeTarget.mock.calls.length).toBe(2)
    expect(applyRuntimeTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        resource: expect.objectContaining({ target: a.identity, resources: { mcp: [], skills: {} } }),
      }),
    )
  })

  it.each(['bootstrap', 'lastGood'] as const)(
    'keeps session.open closed until the first applied target emits boot_ready from %s',
    async (source) => {
      const applyRuntimeTarget = vi.fn(async (target: RuntimeTarget) => report(target))
      const { link, written } = await fixture(applyRuntimeTarget, { AGNES_RUNTIME_BOOT_SOURCE: source })
      const a = artifact('a')
      const b = artifact('b')
      link.push(
        Buffer.from(
          encodeFrame({
            kind: 'session.open',
            requestId: 'open-1',
            sessionKey: 's1',
            params: { binding: { workspaceId: 'w', path: '/tmp' } },
          }),
        ),
      )
      await expect
        .poll(() => written.some((frame) => JSON.stringify(frame).includes('runtime boot is not ready')))
        .toBe(true)
      link.push(Buffer.from(encodeFrame(stale(a))))
      await expect
        .poll(() => written.some((frame) => (frame as { type?: string }).type === 'runtime.boot_ready'))
        .toBe(true)
      const boot = written.find((frame) => (frame as { type?: string }).type === 'runtime.boot_ready') as {
        source: string
        digest: string
      }
      expect(boot).toMatchObject({ source, digest: a.digest })
      await expect
        .poll(() => written.some((frame) => (frame as { type?: string }).type === 'runtime.converged'))
        .toBe(true)
      expect(
        (
          written.find((frame) => (frame as { type?: string }).type === 'runtime.converged') as {
            digest: string
          }
        ).digest,
      ).toBe(a.digest)
      link.push(Buffer.from(encodeFrame(stale(b))))
      await expect
        .poll(
          () =>
            written.filter((frame) => (frame as { type?: string }).type === 'runtime.converged').length >= 2,
        )
        .toBe(true)
      const converged = written.filter(
        (frame) => (frame as { type?: string }).type === 'runtime.converged',
      ) as { digest: string }[]
      expect(converged.map((frame) => frame.digest)).toEqual([a.digest, b.digest])
    },
  )

  it('applies a complete target whose report names each resource-owned id exactly once', async () => {
    const revision = 'e'.repeat(64)
    const complete = encodeRuntimeTargetArtifact(
      buildRuntimeTarget({
        rows: RESOURCE_OWNED_ROW_IDS.map((id) =>
          createPluginRow({
            id,
            plugin: `builtin:host/${id}`,
            snapshotDigest: 'builtin:host:v1',
            exportName: id,
            entryRevision: 'host-row:v1',
            extrasRevision: 'none',
            mountRevision: 'host-row:v1',
          }),
        ),
        resources: { mcp: [], skills: {} },
        resourceRevision: revision,
        compositeRevision: revision,
      }),
    )
    const applyRuntimeTarget = vi.fn(async (target: RuntimeTarget) => {
      const named = RESOURCE_OWNED_ROW_IDS.filter((id) => target.resource.rows[id]?.id === id)
      expect(named).toHaveLength(RESOURCE_OWNED_ROW_IDS.length)
      return {
        hash: target.tree.hash,
        ok: true,
        rows: named.map((id) => ({ id, state: 'active' as const })),
      }
    })
    const { link } = await fixture(applyRuntimeTarget)
    link.push(Buffer.from(encodeFrame(stale(complete))))
    await expect.poll(() => applyRuntimeTarget.mock.calls.length).toBe(1)
    const reportRows = (await applyRuntimeTarget.mock.results[0]?.value)?.rows.map(
      (row: { id: string }) => row.id,
    )
    expect(reportRows).toEqual([...RESOURCE_OWNED_ROW_IDS])
    expect(new Set(reportRows).size).toBe(RESOURCE_OWNED_ROW_IDS.length)
  })
})
