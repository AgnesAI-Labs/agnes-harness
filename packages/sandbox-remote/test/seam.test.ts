import { describe, expect, it } from 'vitest'
import { remoteSandboxSeam } from '../src/seam.js'

const fakeTransport = {
  exec: async () => ({ code: 0, stdout: 'from-transport', stderr: '', truncated: false }),
  upload: async () => {},
  download: async () => [],
  alive: () => true,
  close: async () => {},
}

type ExecCall = { cmd: string[]; opts: Record<string, unknown> }

// Minimal SeamInitContext double: the real shape follows packages/host/src/assemble/packages.ts.
// Reconciled with it, then filled in with the required fields. `adapters.exec` stands in for the
// host's policy-bound exec (createPolicyExec's result, which under a remote deployment already has
// a transport-backed `inner`); the recorder below is how these tests pin that the seam goes through
// the gate rather than around it. The end-to-end proof that the real gate is in the path - and that
// it denies a cwd outside the compiled policy - lives in packages/host's remote-wiring test, which
// can build a real openAdapters bundle.
const ctx = (
  over: Record<string, unknown> = {},
  sink?: {
    exec: ExecCall[]
    gate: unknown[]
    backend: unknown[]
    result?: { code: number; stdout: string; stderr: string; truncated: boolean }
  },
) =>
  ({
    profile: {
      name: 'p',
      resolvedProfileHash: null,
      dataDir: '/d',
      workspaceRoot: '/w',
      homeDir: '/h',
      limits: {},
      preset: {},
    },
    secrets: () => '',
    log: { info() {}, warn() {}, error() {}, debug() {} },
    signal: new AbortController().signal,
    adapters: {
      exec: async (cmd: string[], opts: Record<string, unknown>) => {
        sink?.exec.push({ cmd, opts })
        return sink?.result ?? { code: 0, stdout: 'from-gate', stderr: '', truncated: false }
      },
    } as never,
    sandboxHost: {
      transport: fakeTransport,
      declareExecGate: (state: unknown) => sink?.gate.push(state),
      reportBackend: (report: unknown) => sink?.backend.push(report),
    } as never,
    ...over,
  }) as never

const sink = () => ({ exec: [] as ExecCall[], gate: [] as unknown[], backend: [] as unknown[] })

describe('remote sandbox seam', () => {
  it('routes exec through the host exec gate, stamped with the remote binding - never at the raw transport', async () => {
    const s = sink()
    const seam = await remoteSandboxSeam(ctx({}, s))
    const r = await seam.exec(['echo', 'hi'], { cwd: '/w', env: { A: '1' }, timeoutMs: 5 })
    // 'from-gate', not 'from-transport': the raw transport is not what a tool's exec resolves to.
    // Reaching it directly would skip createPolicyExec's binding check, its digest pin and - the
    // one that matters for this seam - authorizeCwd, which is the only thing that ever applies the
    // file policy compiled below to an exec request.
    expect(r.stdout).toBe('from-gate')
    expect(s.exec).toHaveLength(1)
    expect(s.exec[0]?.cmd).toEqual(['echo', 'hi'])
    expect(s.exec[0]?.opts).toMatchObject({ cwd: '/w', env: { A: '1' }, timeoutMs: 5 })
    expect(s.exec[0]?.opts.sandbox).toEqual({
      policyDigest: seam.fsPolicy().digest,
      backend: 'remote',
    })
  })

  it('declares the remote posture at init, so the three sandbox answers stop reading as unprobed', async () => {
    const s = sink()
    await remoteSandboxSeam(ctx({}, s))
    expect(s.backend).toEqual([{ name: 'remote', enforcement: { level: 'none', scope: [] } }])
    // 'remote', not 'none': 'none' plus RA7's ban on the onUnavailable escape would deadlock every
    // remote exec (spec §4.6.1). 'deny' because a remote deployment never degrades to unconfined
    // local execution.
    expect(s.gate).toEqual([{ backend: 'remote', onUnavailable: 'deny' }])
  })

  it('throws from confine instead of handing back an unconfined argv', async () => {
    const seam = await remoteSandboxSeam(ctx())
    await expect(seam.confine(['python', 'x.py'])).rejects.toThrow(/remote/i)
  })

  it('reports no isolation of its own', async () => {
    const seam = await remoteSandboxSeam(ctx())
    expect(seam.enforcement()).toEqual({ level: 'none', scope: [] })
  })

  it('fits exec and policy to the Host-owned session workspace', async () => {
    const template = await remoteSandboxSeam(ctx())
    const basePolicy = template.fsPolicy()
    const policy = {
      ...basePolicy,
      workspaceRoot: '/sessions/a',
      rules: basePolicy.rules.map((rule) => ({
        ...rule,
        path: rule.path.replace(/^\/w(?=\/|$)/, '/sessions/a'),
      })),
      digest: 'a'.repeat(64),
    }
    const calls: ExecCall[] = []
    const fitted = await template.forWorkspace({
      root: '/sessions/a',
      policy,
      readiness: { ready: async () => ({ confine: ({ argv }) => argv }) },
      shell: 'posix',
      execBackend: 'remote',
      enforcement: { level: 'none', scope: [] },
      exec: async (cmd, opts) => {
        calls.push({ cmd, opts })
        return { code: 0, stdout: 'session', stderr: '', truncated: false }
      },
      binding: () => ({ policyDigest: policy.digest }),
    })
    await expect(fitted.exec(['echo', 'ok'], { cwd: '/sessions/a' })).resolves.toMatchObject({
      stdout: 'session',
    })
    expect(fitted.fsPolicy()).toBe(policy)
    expect(calls[0]?.opts.sandbox).toEqual({ policyDigest: policy.digest, backend: 'remote' })
  })

  it('refuses to initialise without a transport', async () => {
    await expect(
      remoteSandboxSeam(ctx({ sandboxHost: { declareExecGate: () => {}, reportBackend: () => {} } })),
    ).rejects.toThrow(/transport/i)
  })
})

describe('the compiled remote file policy', () => {
  const policyFor = async (preset: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const seam = await remoteSandboxSeam(
      ctx({
        profile: {
          name: 'p',
          resolvedProfileHash: null,
          dataDir: '/d',
          workspaceRoot: '/w',
          homeDir: '/h',
          limits: {},
          preset,
          ...over,
        },
      }),
    )
    return seam.fsPolicy()
  }
  const find = (p: { rules: readonly { path: string; effect: string; hard: boolean }[] }, path: string) =>
    p.rules.find((r) => r.path === path)

  it('carries the host-integrity floor as hard denies - without it bindFsPolicy poisons the fence', async () => {
    const p = await policyFor({})
    expect(find(p, '/w/.git')).toMatchObject({ effect: 'deny', hard: true, source: 'host-integrity' })
    expect(p.rules.filter((r) => r.source === 'host-integrity')).toHaveLength(3)
  })

  // `.agnes/secrets` is where the directory lived before the `.agh` rename; a workspace that still
  // holds one must stay as unreadable as one that has moved.
  it('hard-denies the workspace secrets directory under both its current and its legacy name', async () => {
    const p = await policyFor({})
    for (const path of ['/w/.agh/secrets', '/w/.agnes/secrets'])
      expect(find(p, path), path).toMatchObject({ effect: 'deny', hard: true, source: 'host-integrity' })
  })

  it('hard-denies the credential paths and allows the workspace with the data tmp carve-out', async () => {
    const p = await policyFor({})
    expect(p.workspaceRoot).toBe('/w')
    expect(find(p, '/w')).toMatchObject({ effect: 'allow', hard: false })
    expect(find(p, '/h/.ssh')).toMatchObject({ effect: 'deny', hard: true })
    expect(find(p, '/d/secrets')).toMatchObject({ effect: 'deny', hard: true })
    expect(find(p, '/d')).toMatchObject({ effect: 'deny', hard: false })
    expect(find(p, '/d/tmp')).toMatchObject({ effect: 'allow', hard: false })
  })

  it('resolves relative extra_paths and deny_paths against the remote workspace root', async () => {
    const p = await policyFor({
      sandbox: { extra_paths: ['vendor', '/opt/tools'], deny_paths: ['secrets.env'] },
    })
    expect(find(p, '/w/vendor')).toMatchObject({ effect: 'allow', source: 'extra' })
    expect(find(p, '/opt/tools')).toMatchObject({ effect: 'allow', source: 'extra' })
    expect(find(p, '/w/secrets.env')).toMatchObject({ effect: 'deny', source: 'preset' })
  })

  it('carries the preset network allowlist through unchanged', async () => {
    const p = await policyFor({ sandbox: { network_allow: ['example.com'] } })
    expect(p.networkAllow).toEqual(['example.com'])
  })

  it('refuses a workspace root that is not an absolute remote path', async () => {
    await expect(policyFor({}, { workspaceRoot: 'relative/dir' })).rejects.toThrow(/absolute remote path/i)
  })

  it('refuses a sandbox block that is not a mapping', async () => {
    await expect(policyFor({ sandbox: ['nope'] })).rejects.toThrow(/not a mapping/i)
  })

  it('refuses a non-string extra_paths list', async () => {
    await expect(policyFor({ sandbox: { extra_paths: [1] } })).rejects.toThrow(/extra_paths/i)
  })

  it('computes a digest that is stable for the same inputs and moves when a rule does', async () => {
    const a = await policyFor({})
    const b = await policyFor({})
    const c = await policyFor({ sandbox: { deny_paths: ['x'] } })
    expect(a.digest).toBe(b.digest)
    expect(c.digest).not.toBe(a.digest)
  })
})
