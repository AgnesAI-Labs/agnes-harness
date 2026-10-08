import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkillRoot, skillRoots } from '@agnes/base'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSkillInstaller, type SkillInstallAuthority } from '../../src/resources/skill-install.js'
import type { SkillInstallInvocation } from '../../src/resources/skill-install-port.js'

const roots: string[] = []
const discovery = { roots: skillRoots, discover: discoverSkillRoot }
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup(enable = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-skill-install-')))
  roots.push(root)
  const source = join(root, 'source', 'demo')
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(source, { recursive: true })
  mkdirSync(workspace)
  const document = '---\nname: demo\ndescription: Fixture skill\n---\nUse this fixture.\n'
  writeFileSync(join(source, 'SKILL.md'), document)
  writeFileSync(join(source, 'requirements.txt'), 'never execute this')
  const installer = createSkillInstaller(join(root, 'receipts'), discovery)
  let revision = ''
  const resources = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === '_agnes/v1/resources.operation.get') return { state: 'succeeded' }
    if (method === '_agnes/v1/resources.get')
      return {
        resourceId: params.resourceId,
        revision,
        stale: false,
        resolution: { winner: true },
        actual: 'ready',
        trust: 'trusted',
        desired: 'enabled',
      }
    return { operationId: String(params.commandId) }
  })
  const authority: SkillInstallAuthority = {
    principalId: 'local-user',
    profile: 'local-dev',
    workspaceRoot: workspace,
    agnesHome: home,
    assertActive: vi.fn(),
    ask: vi.fn(async () => true),
    resources,
  }
  const invocation: SkillInstallInvocation = {
    packageId: '@fixture/install',
    snapshotId: 'snapshot',
    leaseId: 'lease',
    rowId: 'ext:fixture/install',
    sessionKey: 'session',
    toolUseId: 'tool',
    deniedPaths: [],
    input: { action: 'prepare', sourceDirectory: source, scope: 'user', enable },
  }
  const signal = new AbortController().signal
  const request = (input: SkillInstallInvocation['input'], changes: Partial<SkillInstallInvocation> = {}) =>
    installer.request({ ...invocation, ...changes, input }, authority, signal)
  const prepare = async () => {
    const result = await request(invocation.input)
    revision = result.revision!
    return result
  }
  const done = async (proposalId: string) => {
    await expect
      .poll(async () => (await request({ action: 'status', proposalId })).state, { timeout: 5000 })
      .not.toBe('running')
    return request({ action: 'status', proposalId })
  }
  return {
    root,
    source,
    home,
    document,
    authority,
    resources,
    installer,
    invocation,
    signal,
    request,
    prepare,
    done,
  }
}

describe('controlled Skill installer', () => {
  it('imports skills with native script and reference paths', async () => {
    const s = setup()
    mkdirSync(join(s.source, 'scripts'))
    mkdirSync(join(s.source, 'references'))
    writeFileSync(join(s.source, 'scripts', 'demo.py'), 'print("fixture")\r\n')
    writeFileSync(join(s.source, 'references', 'guide.md'), '# Reference\r\n')
    const prepared = await s.prepare()
    expect(prepared.fileCount).toBe(4)
    await s.request({ action: 'commit', proposalId: prepared.proposalId })
    expect((await s.done(prepared.proposalId)).state).toBe('ready')
    expect(readFileSync(join(s.home, 'skills', 'demo', 'scripts', 'demo.py'))).toEqual(
      readFileSync(join(s.source, 'scripts', 'demo.py')),
    )
  })

  it('requires content-bound approval, uses frozen bytes, then verifies resource ready', async () => {
    const s = setup()
    const proposal = await s.prepare()
    expect(s.resources).not.toHaveBeenCalled()
    expect(existsSync(join(s.home, 'skills', 'demo'))).toBe(false)
    writeFileSync(join(s.source, 'SKILL.md'), 'changed after preparation')
    await s.request({ action: 'commit', proposalId: proposal.proposalId })
    const result = await s.done(proposal.proposalId)
    expect(result).toMatchObject({ state: 'ready', effective: 'next-turn' })
    expect(readFileSync(join(s.home, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe(s.document)
    expect(s.authority.ask).toHaveBeenCalledTimes(2)
    expect(vi.mocked(s.authority.ask).mock.calls[1]?.[1]).toBe(proposal.digest)
    expect(s.resources.mock.calls.filter(([method]) => method === '_agnes/v1/skills.trust.set')).toHaveLength(
      1,
    )
    expect(
      s.resources.mock.calls.find(([method]) => method === '_agnes/v1/skills.refresh')?.[1],
    ).toMatchObject({
      reinstall: { expectedRevision: proposal.revision, resourceId: expect.stringMatching(/^skill\/user\//) },
    })
  })

  it.each(['read', 'commit'])('refuses %s rejection without publishing', async (phase) => {
    const s = setup()
    if (phase === 'read') {
      vi.mocked(s.authority.ask).mockResolvedValue(false)
      await expect(s.prepare()).rejects.toThrow('SKILL_READ_REJECTED')
    } else {
      const p = await s.prepare()
      vi.mocked(s.authority.ask).mockResolvedValue(false)
      await expect(s.request({ action: 'commit', proposalId: p.proposalId })).rejects.toThrow(
        'SKILL_INSTALL_REJECTED',
      )
    }
    expect(existsSync(join(s.home, 'skills', 'demo'))).toBe(false)
    expect(s.resources).not.toHaveBeenCalled()
  })

  it('honours filesystem denials before source approval or file reads', async () => {
    const s = setup()
    await expect(s.request(s.invocation.input, { deniedPaths: [s.source] })).rejects.toThrow(
      'SKILL_PATH_DENIED',
    )
    expect(s.authority.ask).not.toHaveBeenCalled()
  })

  it('rejects a linked source', async () => {
    const s = setup()
    const link = join(s.root, 'link')
    symlinkSync(s.source, link, 'junction')
    await expect(
      s.request({ action: 'prepare', sourceDirectory: link, scope: 'user', enable: true }),
    ).rejects.toThrow('SKILL_LINK_REFUSED')
  })

  it('refuses unknown fields and another session or revoked row lease', async () => {
    const s = setup()
    await expect(s.request({ ...s.invocation.input, confirmed: true } as never)).rejects.toThrow(
      'SKILL_INSTALL_INVALID',
    )
    const p = await s.prepare()
    await expect(
      s.request({ action: 'commit', proposalId: p.proposalId }, { sessionKey: 'other' }),
    ).rejects.toThrow('SKILL_PROPOSAL_UNAVAILABLE')
    await expect(
      s.request({ action: 'commit', proposalId: p.proposalId }, { leaseId: 'new' }),
    ).rejects.toThrow('SKILL_INSTALL_LEASE_CHANGED')
    expect(s.resources).not.toHaveBeenCalled()
  })

  it('preserves a conflicting target', async () => {
    const s = setup()
    const p = await s.prepare()
    const target = join(s.home, 'skills', 'demo')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), s.document + 'existing work')
    await s.request({ action: 'commit', proposalId: p.proposalId })
    expect(await s.done(p.proposalId)).toMatchObject({ state: 'failed', message: 'SKILL_TARGET_CONFLICT' })
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('existing work')
    expect(s.resources).not.toHaveBeenCalled()
  })

  it('never trusts a different or shadowed revision after refresh', async () => {
    const s = setup()
    const p = await s.prepare()
    s.resources.mockImplementation(async (method) =>
      method === '_agnes/v1/resources.get'
        ? { revision: 'other', stale: false, resolution: { winner: true } }
        : method === '_agnes/v1/resources.operation.get'
          ? { state: 'succeeded' }
          : { operationId: 'operation' },
    )
    await s.request({ action: 'commit', proposalId: p.proposalId })
    expect(await s.done(p.proposalId)).toMatchObject({ state: 'failed', phase: 'refresh' })
    expect(s.resources.mock.calls.some(([m]) => m === '_agnes/v1/skills.trust.set')).toBe(false)
  })

  it('deduplicates commit and reports restart interruption without automatic effects', async () => {
    const s = setup()
    const p = await s.prepare()
    const restarted = createSkillInstaller(join(s.root, 'receipts'), discovery)
    const status = await restarted.request(
      { ...s.invocation, input: { action: 'status', proposalId: p.proposalId } },
      s.authority,
      s.signal,
    )
    expect(status.state).toBe('interrupted')
    await Promise.all([
      s.request({ action: 'commit', proposalId: p.proposalId }),
      s.request({ action: 'commit', proposalId: p.proposalId }),
    ])
    expect((await s.done(p.proposalId)).state).toBe('ready')
    expect(s.resources.mock.calls.filter(([m]) => m === '_agnes/v1/skills.refresh')).toHaveLength(1)
  })

  it('aborts a pending installation approval and never publishes after cancellation', async () => {
    const s = setup()
    const p = await s.prepare()
    let approvalSignal: AbortSignal | undefined
    vi.mocked(s.authority.ask).mockImplementationOnce(async (_summary, _hash, signal) => {
      approvalSignal = signal
      return new Promise<boolean>((resolve) =>
        signal.addEventListener('abort', () => resolve(true), { once: true }),
      )
    })
    const commit = s.request({ action: 'commit', proposalId: p.proposalId }).catch((error) => error)
    await expect.poll(() => approvalSignal !== undefined).toBe(true)
    const cancelled = await s.request({ action: 'cancel', proposalId: p.proposalId })
    expect(cancelled.state).toBe('cancelled')
    expect(approvalSignal?.aborted).toBe(true)
    expect((await commit).message).toBe('SKILL_INSTALL_CANCELLED')
    expect((await s.request({ action: 'status', proposalId: p.proposalId })).state).toBe('cancelled')
    expect(s.resources).not.toHaveBeenCalled()
    expect(existsSync(join(s.home, 'skills', 'demo'))).toBe(false)
  })

  it('honors allowed children of soft denials, but preserves hard and nested denials', async () => {
    const s = setup()
    const pathPolicy = {
      caseSensitive: false,
      policy: {
        workspaceRoot: s.source,
        networkAllow: [],
        digest: '0'.repeat(64),
        rules: [
          { effect: 'deny' as const, path: s.root, hard: false, source: 'data' as const },
          { effect: 'allow' as const, path: s.source, hard: false, source: 'workspace' as const },
        ],
      },
    }
    const prepared = await s.request(s.invocation.input, { deniedPaths: [s.root], pathPolicy })
    expect(prepared.state).toBe('prepared')
    const hard = structuredClone(pathPolicy)
    for (const rule of hard.policy.rules) if (rule.effect === 'deny') rule.hard = true
    await expect(s.request(s.invocation.input, { pathPolicy: hard })).rejects.toThrow('SKILL_PATH_DENIED')
    const nested = structuredClone(pathPolicy)
    nested.policy.rules.push({
      effect: 'deny',
      path: join(s.source, 'requirements.txt'),
      hard: false,
      source: 'data',
    })
    await expect(s.request(s.invocation.input, { pathPolicy: nested })).rejects.toThrow('SKILL_PATH_DENIED')
    await expect(
      s.request({ action: 'commit', proposalId: prepared.proposalId }, { pathPolicy: nested }),
    ).rejects.toThrow('SKILL_PATH_DENIED')
    expect(s.resources).not.toHaveBeenCalled()
  })

  it('cancels a prepared proposal without installing anything', async () => {
    const s = setup()
    const p = await s.prepare()
    expect((await s.request({ action: 'cancel', proposalId: p.proposalId })).state).toBe('cancelled')
    await expect(s.request({ action: 'commit', proposalId: p.proposalId })).rejects.toThrow(
      'SKILL_PROPOSAL_TERMINAL',
    )
    expect(s.resources).not.toHaveBeenCalled()
  })

  it.each(['malformed', 'too-large', 'too-many', 'too-many-directories'])(
    'refuses %s source before install approval',
    async (kind) => {
      const s = setup()
      if (kind === 'malformed') writeFileSync(join(s.source, 'SKILL.md'), 'not a Skill document')
      if (kind === 'too-large') writeFileSync(join(s.source, 'large.txt'), Buffer.alloc(1024 * 1024 + 1))
      if (kind === 'too-many') for (let i = 0; i < 65; i++) writeFileSync(join(s.source, `file-${i}.txt`), '')
      if (kind === 'too-many-directories') for (let i = 0; i < 129; i++) mkdirSync(join(s.source, `dir-${i}`))
      await expect(s.prepare()).rejects.toThrow(/^SKILL_/)
      expect(s.authority.ask).toHaveBeenCalledTimes(1)
      expect(s.resources).not.toHaveBeenCalled()
    },
  )

  it('publishes a complete directory and install-only records a disable instead of enabling', async () => {
    const s = setup(false)
    const p = await s.prepare()
    await s.request({ action: 'commit', proposalId: p.proposalId })
    expect((await s.done(p.proposalId)).state).toBe('installed')
    const calls = s.resources.mock.calls as unknown as Array<[string, Record<string, unknown>]>
    expect(calls.some(([m]) => m.includes('trust.set'))).toBe(false)
    expect(calls.filter(([m]) => m.includes('desired.set')).map(([, params]) => params.state)).toEqual([
      'disabled',
    ])
    expect(readdirSync(s.home).filter((name) => name.startsWith('.skill-install-'))).toEqual([])
  })

  it.runIf(process.platform === 'win32')(
    'Windows directory rename cannot replace even an empty existing target',
    () => {
      const s = setup()
      const occupied = join(s.root, 'occupied')
      mkdirSync(occupied)
      expect(() => renameSync(s.source, occupied)).toThrow()
      expect(readdirSync(occupied)).toEqual([])
      expect(existsSync(join(s.source, 'SKILL.md'))).toBe(true)
    },
  )
})
