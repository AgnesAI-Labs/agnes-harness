import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkillRoot, skillRoots } from '@agnes/base'
import { rpcError, type SkillImportParams } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import type { PackageAdminAuthority } from '../src/packages/permissions.js'
import { skillEnvironment } from '../src/packages/skill-environment.js'
import { createSkillImportService } from '../src/packages/skill-import.js'

// Capture the authority the installer receives so its resource callback can be exercised directly.
const seen = vi.hoisted(() => ({
  authority: undefined as undefined | { resources: (m: string, d: object) => Promise<unknown> },
}))
vi.mock('@agnes/host', async (importActual) => {
  const actual = await importActual<typeof import('@agnes/host')>()
  return {
    ...actual,
    createSkillInstaller: (...args: Parameters<typeof actual.createSkillInstaller>) => {
      const installer = actual.createSkillInstaller(...args)
      return {
        ...installer,
        request: (invocation: never, authority: never, signal: never) => {
          seen.authority = authority
          return installer.request(invocation, authority, signal)
        },
      }
    },
  }
})

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-complete-skill-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  for (const path of [source, home, workspace]) mkdirSync(path)
  for (const name of ['first', 'second']) {
    const path = join(source, name)
    mkdirSync(join(path, 'bin'), { recursive: true })
    writeFileSync(
      join(path, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Synthetic fixture\n---\nRun the bundled tool.`,
    )
    writeFileSync(join(path, 'bin', 'main.mjs'), "throw Error('installation must never execute this')")
  }
  let revision = ''
  const calls: { method: string; permissions: readonly string[] }[] = []
  const service = createSkillImportService({
    directory: join(root, 'operations'),
    home,
    workspace,
    profile: 'local-dev',
    discovery: { roots: skillRoots, discover: discoverSkillRoot },
    environment: async () => [{ name: 'node', state: 'satisfied', evidence: 'probed', actual: '24.20.0' }],
    resources: {
      call: async (method, params, granted) => {
        calls.push({ method, permissions: granted?.permissions ?? [] })
        const data = params as Record<string, unknown>
        if (method === '_agnes/v1/resources.operation.get') return { state: 'succeeded' }
        if (method === '_agnes/v1/resources.get')
          return { revision, stale: false, resolution: { winner: true }, actual: 'disabled' }
        return { operationId: data.commandId }
      },
    },
  })
  cleanup.push(() => service.close())
  const authority: PackageAdminAuthority = {
    audience: 'admin',
    principalId: 'owner',
    clientId: 'client',
    permissions: ['packages.install', 'packages.read'],
  }
  let command = 0
  const request = (
    input: Omit<SkillImportParams, 'profile' | 'clientId' | 'commandId'>,
    changes: Partial<PackageAdminAuthority> = {},
  ) =>
    service.call(
      {
        ...input,
        profile: 'local-dev',
        clientId: changes.clientId ?? 'client',
        commandId: `command-${++command}`,
      },
      { ...authority, ...changes },
    )
  return {
    root,
    calls,
    source,
    home,
    service,
    authority,
    request,
    revision: (value: string) => {
      revision = value
    },
  }
}

it('selects and installs complete Skills through the shared installer without running source code', async () => {
  const s = fixture()
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  expect(await s.request({ action: 'prepare', source })).toMatchObject({
    state: 'selection_required',
    candidates: ['first', 'second'],
  })
  const prepared = await s.request({ action: 'prepare', source, subdirectory: 'second' })
  if (!prepared.proposalId || !prepared.revision || !prepared.digest)
    throw new Error('missing prepared identity')
  const proposalId = prepared.proposalId
  expect(prepared).toMatchObject({
    state: 'prepared',
    name: 'second',
    scope: 'user',
    files: ['AGH-SKILL.json', 'SKILL.md', 'bin/main.mjs'],
    environment: [{ name: 'node', state: 'satisfied' }],
  })
  expect(existsSync(join(s.home, 'skills/second'))).toBe(false)
  await expect(
    s.request({ action: 'commit', proposalId: prepared.proposalId, expectedDigest: '0'.repeat(64) }),
  ).rejects.toMatchObject({ data: { reason: 'SKILL_SOURCE_CHANGED' } })
  await expect(
    s.request({ action: 'status', proposalId: prepared.proposalId }, { principalId: 'other' }),
  ).rejects.toMatchObject({ data: { reason: 'SKILL_PROPOSAL_UNAVAILABLE' } })
  s.revision(prepared.revision)
  await s.request(
    { action: 'commit', proposalId: prepared.proposalId, expectedDigest: prepared.digest },
    { clientId: 'second-connection' },
  )
  await expect.poll(async () => (await s.request({ action: 'status', proposalId })).state).toBe('installed')
  expect(readFileSync(join(s.home, 'skills/second/bin/main.mjs'), 'utf8')).toContain('must never execute')
})

it('checks a repository asynchronously, resolves a sole Skill and allows cancellation without publication', async () => {
  const s = fixture()
  rmSync(join(s.source, 'second'), { recursive: true })
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  const check = await s.request({ action: 'check', source })
  expect(check).toMatchObject({ state: 'running', phase: 'acquiring' })
  expect(check.proposalId).toBeTruthy()
  if (!check.proposalId) throw new Error('missing check id')
  const checkId = check.proposalId
  await expect(
    s.request({ action: 'status', proposalId: checkId }, { principalId: 'other' }),
  ).rejects.toMatchObject({ data: { reason: 'SKILL_PROPOSAL_UNAVAILABLE' } })
  await expect
    .poll(async () => (await s.request({ action: 'status', proposalId: checkId })).state)
    .toBe('prepared')
  const prepared = await s.request({ action: 'status', proposalId: check.proposalId })
  if (!prepared.proposalId) throw new Error('missing proposal')
  expect(prepared).toMatchObject({ state: 'prepared', name: 'first', fileCount: 3 })
  expect(existsSync(join(s.home, 'skills/first'))).toBe(false)
  await s.request({ action: 'cancel', proposalId: check.proposalId })
  expect(await s.request({ action: 'status', proposalId: prepared.proposalId })).toMatchObject({
    state: 'cancelled',
  })
  const cancelled = await s.request({ action: 'check', source })
  if (!cancelled.proposalId) throw new Error('missing check id')
  expect(await s.request({ action: 'cancel', proposalId: cancelled.proposalId })).toMatchObject({
    state: 'cancelled',
  })
  const failed = await s.request({ action: 'check', source: { type: 'path', ref: 'path:missing-fixture' } })
  if (!failed.proposalId) throw new Error('missing check id')
  const failedId = failed.proposalId
  await expect
    .poll(async () => (await s.request({ action: 'status', proposalId: failedId })).state)
    .toBe('failed')
  expect(await s.request({ action: 'status', proposalId: failed.proposalId })).toMatchObject({
    message: 'SKILL_SOURCE_UNAVAILABLE',
  })
})

it('refuses a foreign activation bundle and native declarations without falling back to Skill import', async () => {
  const s = fixture()
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  writeFileSync(join(s.source, 'package.json'), '{"dsh":null}')
  expect(await s.request({ action: 'prepare', source })).toMatchObject({
    state: 'unsupported',
    message: 'SKILL_FOREIGN_RUNTIME_UNSUPPORTED',
  })
  writeFileSync(join(s.source, 'cordis.patch.yml'), '!!js throw new Error("must never execute")')
  expect(await s.request({ action: 'prepare', source })).toMatchObject({
    state: 'unsupported',
    message: 'SKILL_FOREIGN_RUNTIME_UNSUPPORTED',
  })
  writeFileSync(join(s.source, 'package.json'), '{"agnes":null}')
  expect(await s.request({ action: 'prepare', source })).toMatchObject({
    state: 'unsupported',
    message: 'SKILL_NATIVE_PACKAGE_USE_PLUGIN_INSTALL',
  })
  writeFileSync(
    join(s.source, 'first/SKILL.md'),
    '---\nname: first\ndescription: Restricted foreign Skill\nallowed-tools: private_tool\n---\nInstructions.',
  )
  expect(await s.request({ action: 'prepare', source, subdirectory: 'first' })).toMatchObject({
    state: 'unsupported',
    message: 'SKILL_DOCUMENT_PROFILE_UNSUPPORTED',
  })
})

it('binds retry identities and cancels prepared content without publication', async () => {
  const s = fixture()
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  const input: SkillImportParams = {
    profile: 'local-dev',
    clientId: 'client',
    commandId: 'same-command',
    action: 'prepare',
    source: { type: 'path', ref: `path:${s.source.replaceAll('\\', '/')}` },
    subdirectory: 'first',
  }
  const first = await s.service.call(input, s.authority)
  if (!first.proposalId) throw new Error('missing prepared identity')
  expect(await s.service.call(input, s.authority)).toEqual(first)
  await expect(s.service.call({ ...input, subdirectory: 'second' }, s.authority)).rejects.toMatchObject({
    data: { reason: 'COMMAND_ID_CONFLICT' },
  })
  expect(await s.request({ action: 'cancel', proposalId: first.proposalId })).toMatchObject({
    state: 'cancelled',
  })
  expect(existsSync(join(s.home, 'skills/first'))).toBe(false)
  await expect(s.request({ action: 'prepare', source }, { installer: 'agent' })).rejects.toMatchObject(
    rpcError('CAPABILITY_DENIED'),
  )
})

it('refuses local source trees overlapping private installation state before acquisition', async () => {
  const s = fixture()
  const secret = join(s.home, 'secrets')
  mkdirSync(secret)
  writeFileSync(join(secret, 'SKILL.md'), 'not an importable private resource')
  await expect(
    s.request({ action: 'prepare', source: { type: 'path', ref: `path:${secret.replaceAll('\\', '/')}` } }),
  ).rejects.toThrow('protected installation state')
  expect(existsSync(join(s.home, 'skills'))).toBe(false)
})

it('keeps management imports on the session resource allowlist and gates enabling on trust and activation', async () => {
  const s = fixture()
  const source = { type: 'path' as const, ref: `path:${s.source.replaceAll('\\', '/')}` }
  const prepared = await s.request({ action: 'prepare', source, subdirectory: 'first' })
  if (!prepared.proposalId || !prepared.revision || !prepared.digest) throw new Error('missing identity')
  s.revision(prepared.revision)
  const proposalId = prepared.proposalId
  // enable:false by an install-only caller records a disabled desired state and never trusts.
  await s.request({ action: 'commit', proposalId, expectedDigest: prepared.digest })
  await expect.poll(async () => (await s.request({ action: 'status', proposalId })).state).toBe('installed')
  expect(existsSync(join(s.home, 'skills/first'))).toBe(true)
  expect(s.calls.map((c) => c.method)).not.toContain('_agnes/v1/skills.trust.set')
  expect(s.calls.find((c) => c.method === '_agnes/v1/resources.desired.set')?.permissions).toEqual([
    'resources.skills.write',
  ])
  const resources = seen.authority?.resources
  if (!resources) throw new Error('missing installer authority')
  s.calls.length = 0
  await expect(resources('_agnes/v1/skills.remove', {})).rejects.toMatchObject(rpcError('CAPABILITY_DENIED'))
  await expect(resources('_agnes/v1/mcp.servers.list', {})).rejects.toMatchObject(
    rpcError('CAPABILITY_DENIED'),
  )
  await expect(resources('_agnes/v1/skills.trust.set', { trust: 'trusted' })).rejects.toMatchObject(
    rpcError('CAPABILITY_DENIED'),
  )
  await expect(resources('_agnes/v1/resources.desired.set', { state: 'enabled' })).rejects.toMatchObject(
    rpcError('CAPABILITY_DENIED'),
  )
  expect(s.calls).toEqual([])
})

it('probes python3 before python and reports missing only when both fail', async () => {
  const probe = (available: Record<string, string>) => async (command: string) => {
    if (!(command in available)) throw new Error('ENOENT')
    return { stdout: `Python ${available[command]}\n` } as never
  }
  const probed = (available: Record<string, string>) =>
    skillEnvironment('.', ['tool.py'], '.', new AbortController().signal, probe(available))
  expect(await probed({ python3: '3.12.1' })).toEqual([
    { name: 'python', state: 'satisfied', evidence: 'probed', actual: '3.12.1' },
  ])
  expect(await probed({ python: '3.9.0' })).toMatchObject([{ name: 'python', actual: '3.9.0' }])
  expect(await probed({ python3: '3.12.1', python: '2.7.18' })).toMatchObject([{ actual: '3.12.1' }])
  expect(await probed({})).toEqual([{ name: 'python', state: 'missing', evidence: 'probed' }])
})
