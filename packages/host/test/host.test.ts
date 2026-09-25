import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ecosystem as baseEcosystem } from '@agnes/base'
import { WORKSPACE_HOOK_SANDBOX, type WorkspaceHookSandbox } from '@agnes/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHost } from '../src/host.js'
import { createTestHost } from '../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))

describe('createHost', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'agnes-host-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  // Named for what it observes: the audit trail. The close *order* is the rollback stack's, and is
  // observed in lifecycle.test.ts - `host.closed` being the last line says nothing about it.
  it('exposes profile, kernel and provider, and records the trail from resolve to close', async () => {
    const dataDir = tmp()
    const { host, audit } = await createTestHost({ dataDir })
    expect(host.profile.name).toBe('local-dev')
    expect(host.provider).toBeDefined()
    expect(host.extensions()).toEqual([])
    await host.close()
    const kinds = audit.events.map((e) => e.kind)
    expect(kinds).toContain('profile.resolved')
    expect(kinds).toContain('host.ready')
    expect(kinds.at(-1)).toBe('host.closed')
    await expect(host.createSession({ cwd: dataDir })).rejects.toThrow(/E_HOST_CLOSED/)
  })
  it('the closed refusal carries the lifecycle code, not a seam code', async () => {
    const { host } = await createTestHost({ dataDir: tmp() })
    await host.close()
    const e = await host.createSession({ cwd: '.' }).then(
      () => {
        throw new Error('expected a refusal')
      },
      (x: unknown) => x as { code: string },
    )
    expect(e.code).toBe('E_HOST_CLOSED')
  })
  it('a second close is a no-op, not a second teardown', async () => {
    const { host, audit } = await createTestHost({ dataDir: tmp() })
    await host.close()
    const after = audit.events.length
    await host.close()
    expect(audit.events.length).toBe(after)
    expect(audit.events.filter((e) => e.kind === 'host.closed')).toHaveLength(1)
  })
  it('concurrent close callers join the same shutdown', async () => {
    const { host, audit } = await createTestHost({ dataDir: tmp() })
    const first = host.close()
    const second = host.close()
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(audit.events.filter((e) => e.kind === 'host.closed')).toHaveLength(1)
  })
  it('keeps the workspace invocation alive through a real shutdown hook, then revokes it', async () => {
    const dataDir = tmp()
    let entered!: () => void
    let finish!: () => void
    const hookEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const hookGate = new Promise<void>((resolve) => {
      finish = resolve
    })
    let hookEnforcement: ReturnType<WorkspaceHookSandbox['enforcement']> | undefined
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      packages: {
        '@agnes/base': {
          ecosystem: {
            ...baseEcosystem,
            'agnes/hooks-runner': (init) => {
              const inner = baseEcosystem['agnes/hooks-runner'](init)
              return (api) => {
                const dispose = inner(api)
                const stop = api.registerHook('shutdown', async (_payload, context) => {
                  const sandbox = (
                    context as typeof context & {
                      [WORKSPACE_HOOK_SANDBOX]: WorkspaceHookSandbox
                    }
                  )[WORKSPACE_HOOK_SANDBOX]
                  hookEnforcement = sandbox.enforcement()
                  entered()
                  await hookGate
                })
                return () => {
                  stop()
                  return Promise.resolve(dispose).then((cleanup) => {
                    if (typeof cleanup === 'function') cleanup()
                  })
                }
              }
            },
          },
        },
      },
    })
    const session = await host.createSession({ cwd: dataDir })
    const invocation = session.d.workspaceInvocation
    if (!invocation) throw new Error('missing workspace invocation')

    const closing = host.close()
    await hookEntered
    expect(hookEnforcement).toEqual({ level: 'full', scope: ['file', 'network', 'process'] })
    await expect(invocation.run(async (view) => view.hookSandbox().enforcement())).resolves.toEqual({
      level: 'full',
      scope: ['file', 'network', 'process'],
    })
    finish()
    await closing
    await expect(
      Promise.resolve().then(() => invocation.run(async (view) => view.hookSandbox().enforcement())),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
  })
  it('close claims a session opening before the kernel publishes it', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir })
    const original = host.kernel.session.bind(host.kernel)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(host.kernel, 'session').mockImplementation(async (...args) => {
      entered()
      await held
      return original(...args)
    })
    const opening = host.createSession({ cwd: dataDir })
    // An opening that fails before reaching the kernel rejects here instead of hanging the test.
    await Promise.race([started, opening])
    const closing = host.close()
    release()
    await expect(opening).rejects.toMatchObject({ code: 'E_HOST_CLOSED' })
    await closing
    expect(host.kernel.sessions.size).toBe(0)
  })
  it('a forced close returns on time without tearing resources from a live session', async () => {
    const dataDir = tmp()
    let seamClosed = 0
    const { host, audit } = await createTestHost({
      dataDir,
      closeTimeoutMs: 50,
      hangSessionClose: true,
      onSeamClose: () => {
        seamClosed++
      },
    })
    await host.createSession({ cwd: dataDir })
    const t0 = Date.now()
    await host.close()
    expect(Date.now() - t0).toBeLessThan(2000)
    // Lower layers remain owned until the live session really settles. Releasing them here would
    // leave that session running against a closed workspace, kernel and storage stack.
    expect(seamClosed).toBe(0)
    expect(audit.events.some((event) => event.kind === 'host.closed')).toBe(false)
    expect(audit.events.some((e) => e.kind === 'session.close_failed')).toBe(false)
  })
  it('a clean close reports it was not forced and lists no failed teardown', async () => {
    const dataDir = tmp()
    const { host, audit } = await createTestHost({ dataDir })
    await host.createSession({ cwd: dataDir })
    await host.close()
    expect(audit.events.at(-1)).toMatchObject({ kind: 'host.closed', detail: { forced: false, failed: [] } })
  })
  it('writes the audit trail to a file when no sink is injected', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir, fileAudit: true })
    await host.close()
    const lines = readFileSync(join(dataDir, 'audit', 'host.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; at: string })
    expect(lines.map((l) => l.kind)).toContain('host.ready')
    expect(lines.at(-1)?.kind).toBe('host.closed')
    expect(lines.every((l) => typeof l.at === 'string')).toBe(true)
  })
  // D21: createFileAudit's constructor eagerly mkdir's, so a rejection that runs before the loader
  // check used to leave a real audit/ directory on disk behind a createHost() call that was always
  // going to fail. A missing loader is a refusal, not a partial assembly, and should leave nothing.
  it('a missing loader is refused with no audit directory left behind', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir: tmp() })
    await host.close()
    await expect(
      createHost(host.profile, {
        dataDir,
        profileDir: `${dataDir}/profiles/local-dev`,
        workspaceRoot: dataDir,
        hostRoot: process.cwd(),
        log: { debug() {}, info() {}, warn() {}, error() {} },
      }),
    ).rejects.toThrow(/E_DEP_MISSING/)
    expect(existsSync(join(dataDir, 'audit'))).toBe(false)
  })
})
