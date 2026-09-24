import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

// bootstrapWorkerResources reads the fixed, profile-keyed snapshot path twice (once to parse it,
// once more to compute `revision`). A daemon-side writeWorkerSnapshot() can overwrite that same
// path in between (different process, not serialized against this read). Simulate that by making
// `node:fs`'s readFileSync return one content on its first call and a different, still-valid
// content on every call after that, for the snapshot path only; every other path used by the real
// scanSkills filesystem walk is forwarded to the real implementation untouched.
const target = vi.hoisted(() => ({ path: '', callCount: 0 }))
const contents = vi.hoisted(() => ({ first: '', second: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (path: unknown, options?: unknown) => {
      if (typeof path === 'string' && path === target.path) {
        target.callCount += 1
        return target.callCount === 1 ? contents.first : contents.second
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, options)
    },
  }
})

const { bootstrapWorkerResources } = await import('../src/runtime-bootstrap.js')

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const barrier = {
  quiesce: async <T>(_operationId: string, publish: (permit: unknown) => Promise<T>): Promise<T> =>
    publish({}),
}

const roots: string[] = []
afterEach(async () => {
  target.path = ''
  target.callCount = 0
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('revision reflects the snapshot bytes actually used to build state, not a later re-read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-runtime-bootstrap-revision-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const home = join(root, 'empty-home') // no Skill roots here: keeps the scan fast and deterministic
  const snapshot = join(root, 'worker-snapshots', 'default.json')
  await mkdir(join(root, 'worker-snapshots'), { recursive: true })

  // Content A: what the daemon read before spawning the worker, and what the worker's first
  // readFileSync sees -- the bytes that actually build skills/mcp/runtime state this generation.
  const contentA = JSON.stringify({
    version: 1,
    mcpAuthority: 'resource-control',
    skills: { control: { desired: [], trust: [] } },
    mcp: [],
  })
  // Content B: a same-profile daemon-side overwrite landing between the two reads -- still a
  // valid snapshot, just a different generation's bytes.
  const contentB = JSON.stringify({
    version: 1,
    mcpAuthority: 'resource-control',
    skills: {
      control: {
        desired: [{ resourceId: `skill/user/agnes/${'a'.repeat(64)}`, state: 'enabled' }],
        trust: [],
      },
    },
    mcp: [],
  })
  expect(contentA).not.toEqual(contentB)
  await writeFile(snapshot, contentA)

  target.path = snapshot
  contents.first = contentA
  contents.second = contentB

  const state = await bootstrapWorkerResources({
    env: { AGNES_RESOURCE_SNAPSHOT: snapshot, AGNES_RESOURCE_SKILL_ONLY: '1', HOME: home },
    cwd: workspace,
    profile: { name: 'default', dataDir: root, adapters: { secrets: { kind: 'env' } } },
    createBarrier: () => barrier,
    createSecrets: () => {
      throw new Error('no secrets are required for this snapshot')
    },
  })
  try {
    expect(state).toBeDefined()
    // The daemon precomputes its expected revision from the bytes on disk before spawning the
    // worker (service-adapters.ts's currentSnapshotRevision) and hard-fails on any mismatch
    // (service-adapters.ts's `hello.resources.snapshotRevision !== revision` check). The worker's
    // self-reported revision must therefore be the digest of the bytes it actually used, not of
    // whatever a second, later read happens to observe.
    expect(state?.revision).toBe(digest(contentA))
  } finally {
    await state?.runtime.mcp.close()
  }
})

it('revision for an untouched snapshot equals the plain sha256 digest of its bytes (daemon-side parity)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-runtime-bootstrap-revision-stable-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const home = join(root, 'empty-home')
  const snapshot = join(root, 'worker-snapshots', 'default.json')
  await mkdir(join(root, 'worker-snapshots'), { recursive: true })

  const content = JSON.stringify({
    version: 1,
    mcpAuthority: 'resource-control',
    skills: { control: { desired: [], trust: [] } },
    mcp: [],
  })
  await writeFile(snapshot, content)
  // target.path left unset: readFileSync is not intercepted, so this exercises the real fs read.

  const state = await bootstrapWorkerResources({
    env: { AGNES_RESOURCE_SNAPSHOT: snapshot, AGNES_RESOURCE_SKILL_ONLY: '1', HOME: home },
    cwd: workspace,
    profile: { name: 'default', dataDir: root, adapters: { secrets: { kind: 'env' } } },
    createBarrier: () => barrier,
    createSecrets: () => {
      throw new Error('no secrets are required for this snapshot')
    },
  })
  try {
    // Same algorithm/encoding the daemon uses in service-adapters.ts's currentSnapshotRevision:
    // sha256 of the utf8 bytes, hex-encoded. Equality here is what the strict `!==` comparison in
    // service-adapters.ts depends on.
    expect(state?.revision).toBe(digest(content))
  } finally {
    await state?.runtime.mcp.close()
  }
})
