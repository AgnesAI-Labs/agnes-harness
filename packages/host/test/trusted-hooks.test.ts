import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPlatform } from '../src/adapters/platform.js'
import { trustedHookCommands } from '../src/assemble/trusted-hooks.js'

const dirs: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-hook-grants-'))
  dirs.push(root)
  const workspace = join(root, 'work'),
    other = join(root, 'work-other')
  mkdirSync(workspace)
  mkdirSync(other)
  return { root, workspace, other }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const digest = `sha256-${'a'.repeat(64)}`
const semantics = createPlatform().fs()
const policy = (workspaceRoot: string) => ({
  trustedUnconfined: [{ source: 'workspace' as const, configDigest: digest, workspaceRoot }],
})
it('matches source, digest and exact workspace, keeps a private copy and exposes no mutable grant list', () => {
  const { workspace, other } = fixture(),
    input = policy(workspace)
  const capability = trustedHookCommands(input, workspace, semantics)
  expect(capability?.allowsUnconfined('workspace', digest)).toBe(true)
  expect(capability?.allowsUnconfined('data', digest)).toBe(false)
  expect(capability?.allowsUnconfined('workspace', `${digest}0`)).toBe(false)
  expect(trustedHookCommands(input, other, semantics)?.allowsUnconfined('workspace', digest)).toBe(false)
  const first = input.trustedUnconfined[0]
  if (!first || !capability) throw new Error('missing grant fixture')
  first.workspaceRoot = other
  expect(capability?.allowsUnconfined('workspace', digest)).toBe(true)
  expect(Object.isFrozen(capability)).toBe(true)
  expect(Object.keys(capability)).toEqual(['allowsUnconfined'])
})
it('preserves no-grant defaults and rejects malformed policy or unknown path semantics', () => {
  const { workspace } = fixture()
  expect(trustedHookCommands(undefined, workspace, semantics)).toBeUndefined()
  expect(
    trustedHookCommands({ trustedUnconfined: [] }, workspace, semantics)?.allowsUnconfined(
      'workspace',
      digest,
    ),
  ).toBe(false)
  expect(() => trustedHookCommands({ allow: true } as never, workspace, semantics)).toThrow(
    /invalid command hooks/,
  )
  expect(() => trustedHookCommands(policy(workspace), workspace, { ...semantics, pathSep: '?' })).toThrow(
    /path semantics/,
  )
})
it('rechecks directory aliases and refuses a grant or workspace redirected after assembly', () => {
  const { root, workspace, other } = fixture(),
    alias = join(root, 'alias')
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(workspace, alias, type)
  const grantAlias = trustedHookCommands(policy(alias), workspace, semantics)
  const workspaceAlias = trustedHookCommands(policy(workspace), alias, semantics)
  expect(grantAlias?.allowsUnconfined('workspace', digest)).toBe(true)
  expect(workspaceAlias?.allowsUnconfined('workspace', digest)).toBe(true)
  unlinkSync(alias)
  symlinkSync(other, alias, type)
  expect(grantAlias?.allowsUnconfined('workspace', digest)).toBe(false)
  expect(workspaceAlias?.allowsUnconfined('workspace', digest)).toBe(false)
})
it.skipIf(process.platform !== 'win32')(
  'does not convert drive-less roots to the current Windows drive',
  () => {
    const { workspace } = fixture()
    const withoutDrive = workspace.slice(2)
    expect(
      trustedHookCommands(policy(withoutDrive.replaceAll('\\', '/')), workspace, semantics)?.allowsUnconfined(
        'workspace',
        digest,
      ),
    ).toBe(false)
  },
)

it('refuses a missing grant target and a workspace removed after assembly', () => {
  const { root, workspace } = fixture()
  expect(
    trustedHookCommands(policy(join(root, 'missing')), workspace, semantics)?.allowsUnconfined(
      'workspace',
      digest,
    ),
  ).toBe(false)
  const capability = trustedHookCommands(policy(workspace), workspace, semantics)
  rmSync(workspace, { recursive: true })
  expect(capability?.allowsUnconfined('workspace', digest)).toBe(false)
})
