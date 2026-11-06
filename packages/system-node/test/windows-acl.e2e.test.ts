// Real NTFS behaviour of the Windows workspace grant primitives, on synthetic directories under the
// system temporary directory. The non-NTFS case attaches a small FAT32 virtual disk and needs an
// elevated shell.
import { execFileSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyWindowsAclGrant,
  inspectWindowsAcl,
  readWindowsObjectIdentity,
  restoreWindowsAclGrant,
  type WindowsAclSnapshot,
  windowsAclFingerprint,
  windowsAclGrantEntries,
} from '../src/windows-acl.js'

const USERS = '*S-1-5-32-545'
let base = ''
let scripts = ''
const links: string[] = []

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agh-acl-'))
  scripts = mkdtempSync(join(tmpdir(), 'agh-acl-tools-'))
})
afterEach(() => {
  for (const link of links.splice(0)) rmdirSync(link)
  // Fixtures may carry protected, empty or NULL DACLs; reset them before removal. icacls reports a
  // nonzero status for any object it skips, and the removal below still fails loudly if needed.
  for (const directory of [base, scripts]) {
    try {
      execFileSync('icacls', [directory, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' })
    } catch {}
    rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
  }
})

const pause = new Int32Array(new SharedArrayBuffer(4))
const code = (expected: string) => expect.objectContaining({ code: expected })
const icacls = (path: string, ...args: string[]) => execFileSync('icacls', [path, ...args], { stdio: 'pipe' })
const writeSid = () => `S-1-4-${randomInt(1, 2 ** 30)}-${randomInt(1, 2 ** 30)}`
const aces = (sddl: string) => sddl.match(/\([^()]*\)/g) ?? []
const key = (snapshot: { identity: { volumeId: string; fileId: string } }) =>
  `${snapshot.identity.volumeId}:${snapshot.identity.fileId}`

function currentUserSid(): string {
  const line = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim()
  const sid = /"(S-1-[\d-]+)"$/.exec(line)?.[1]
  if (!sid) throw new Error(`Cannot read the current user SID from: ${line}`)
  return sid
}

// SetFileSecurityW with a self-relative descriptor whose DACL is present but NULL. Neither icacls
// nor the .NET ACL classes can express a NULL DACL.
function setNullDacl(path: string): void {
  const script = join(scripts, 'null-dacl.ps1')
  writeFileSync(
    script,
    `param([string]$Path)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AghNullDacl {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool SetFileSecurityW(string name, uint information, byte[] descriptor);
  public static void Apply(string path) {
    byte[] descriptor = new byte[20];
    descriptor[0] = 1; descriptor[2] = 0x04; descriptor[3] = 0x80;
    if (!SetFileSecurityW(path, 4, descriptor)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
[AghNullDacl]::Apply($Path)
`,
  )
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, path],
    { stdio: 'pipe' },
  )
}

function workspace(): string {
  const root = join(base, '工作 区')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.txt'), 'a')
  mkdirSync(join(root, 'own'))
  writeFileSync(join(root, 'own', 'b.txt'), 'b')
  icacls(join(root, 'own'), '/grant', `${USERS}:(OI)(CI)(RX)`)
  icacls(root, '/grant', `${USERS}:(RX)`)
  return root
}

function grant(before: WindowsAclSnapshot, sid: string) {
  const result = applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid: sid })
  const root = result.changes.find((change) => key(change) === key(before))
  return { result, root }
}

describe.skipIf(process.platform !== 'win32')('Windows ACL primitives on NTFS', () => {
  it('keeps one identity for a Chinese, spaced and long root across inspections', () => {
    const root = join(base, '工作 区 空格')
    const long = join(root, 'a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100))
    mkdirSync(long, { recursive: true })
    expect(long.length).toBeGreaterThan(260)
    for (const path of [root, long]) {
      const first = inspectWindowsAcl(path)
      const second = inspectWindowsAcl(path)
      expect(second.identity).toEqual(first.identity)
      expect(first.path).toBe(realpathSync.native(path))
      expect(first.fingerprint).toBe(windowsAclFingerprint(first.identity, first.securityDescriptor))
      // An NTFS file reference is a 64-bit number; the 128-bit ID reads the same.
      expect(BigInt(`0x${first.identity.fileId}`)).toBe(statSync(path, { bigint: true }).ino)
    }
  })

  it('a replacement directory never inherits the root identity', () => {
    const root = join(base, 'project')
    const moved = join(base, 'archived')
    mkdirSync(root)
    const before = inspectWindowsAcl(root)
    renameSync(root, moved)
    mkdirSync(root)
    expect(inspectWindowsAcl(root).identity).not.toEqual(before.identity)
    expect(inspectWindowsAcl(moved).identity).toEqual(before.identity)
    expect(() => applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid: writeSid() })).toThrow(
      code('E_ACL_IDENTITY_MISMATCH'),
    )
  })

  it('refuses a drive root, links, files and missing roots', () => {
    expect(() => inspectWindowsAcl(parse(base).root)).toThrow(code('E_ACL_DRIVE_ROOT'))
    const target = join(base, 'target')
    const link = join(base, 'link')
    mkdirSync(join(target, 'child'), { recursive: true })
    symlinkSync(target, link, 'junction')
    links.push(link)
    expect(() => inspectWindowsAcl(link)).toThrow(code('E_ACL_REPARSE'))
    expect(() => inspectWindowsAcl(join(link, 'child'))).toThrow(code('E_ACL_REPARSE'))
    writeFileSync(join(base, 'file'), '')
    expect(() => inspectWindowsAcl(join(base, 'file'))).toThrow(code('ENOTDIR'))
    expect(() => inspectWindowsAcl(join(base, 'missing'))).toThrow(code('ENOENT'))
  })

  it('reads a root identity under the same refusals, without the tree', () => {
    const root = workspace()
    expect(readWindowsObjectIdentity(root)).toEqual(inspectWindowsAcl(root).identity)
    const link = join(base, 'identity-link')
    symlinkSync(root, link, 'junction')
    links.push(link)
    expect(() => readWindowsObjectIdentity(link)).toThrow(code('E_ACL_REPARSE'))
    expect(() => readWindowsObjectIdentity(join(link, 'src'))).toThrow(code('E_ACL_REPARSE'))
    expect(() => readWindowsObjectIdentity(parse(base).root)).toThrow(code('E_ACL_DRIVE_ROOT'))
    expect(() => readWindowsObjectIdentity(join(base, 'missing'))).toThrow(code('ENOENT'))
  })

  it('records a link that stays inside the root and refuses one that leaves it', () => {
    const root = join(base, 'root')
    mkdirSync(join(root, 'real'), { recursive: true })
    mkdirSync(join(base, 'outside'))
    const inside = join(root, 'inside-link')
    symlinkSync(join(root, 'real'), inside, 'junction')
    links.push(inside)
    expect(inspectWindowsAcl(root).descendants.map(({ path }) => basename(path))).toContain('inside-link')
    const outside = join(root, 'outside-link')
    symlinkSync(join(base, 'outside'), outside, 'junction')
    links.push(outside)
    expect(() => inspectWindowsAcl(root)).toThrow(code('E_ACL_REPARSE'))
  })

  it('refuses a volume that is not NTFS', () => {
    try {
      execFileSync('net', ['session'], { stdio: 'ignore' })
    } catch {
      throw new Error('This case needs an elevated shell: it attaches a FAT32 virtual disk with diskpart')
    }
    const letter = [...'ZYXWVUTSRQPONMLKJIHG'].find((candidate) => !existsSync(`${candidate}:\\`))
    if (!letter) throw new Error('No free drive letter for the FAT32 virtual disk')
    const disk = join(scripts, 'fat32.vhd')
    const diskpart = (name: string, lines: string[]) => {
      const script = join(scripts, name)
      writeFileSync(script, `${lines.join('\r\n')}\r\n`)
      execFileSync('diskpart', ['/s', script], { stdio: 'pipe' })
    }
    diskpart('attach.txt', [
      `create vdisk file="${disk}" maximum=64 type=expandable`,
      `select vdisk file="${disk}"`,
      'attach vdisk',
      'create partition primary',
      'format fs=fat32 quick label=AGHACL',
      `assign letter=${letter}`,
    ])
    try {
      const deadline = Date.now() + 30_000
      while (!existsSync(`${letter}:\\`) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 250)
      const root = `${letter}:\\workspace`
      mkdirSync(root)
      expect(() => inspectWindowsAcl(root)).toThrow(code('E_ACL_UNSUPPORTED_VOLUME'))
    } finally {
      diskpart('detach.txt', [`select vdisk file="${disk}"`, 'detach vdisk'])
    }
  }, 120_000)

  it('tells a NULL DACL from an empty DACL', () => {
    const nullRoot = join(base, 'null-root')
    mkdirSync(nullRoot)
    setNullDacl(nullRoot)
    expect(() => inspectWindowsAcl(nullRoot)).toThrow(code('E_ACL_NULL_DACL'))

    const root = join(base, 'root')
    mkdirSync(root)
    writeFileSync(join(root, 'empty.txt'), '')
    icacls(join(root, 'empty.txt'), '/inheritance:r')
    const empty = inspectWindowsAcl(root).descendants.find(({ path }) => basename(path) === 'empty.txt')
    expect(empty?.securityDescriptor).toMatch(/D:P(?!\()/)
    expect(empty?.securityDescriptor).not.toContain('NO_ACCESS_CONTROL')
    writeFileSync(join(root, 'null.txt'), '')
    setNullDacl(join(root, 'null.txt'))
    expect(() => inspectWindowsAcl(root)).toThrow(
      expect.objectContaining({ code: 'E_ACL_NULL_DACL', path: join(realpathSync.native(root), 'null.txt') }),
    )

    // An empty root DACL denies listing it: refused for missing rights, not as a NULL DACL.
    const emptyRoot = join(base, 'empty-root')
    mkdirSync(emptyRoot)
    icacls(emptyRoot, '/inheritance:r')
    expect(() => inspectWindowsAcl(emptyRoot)).toThrow(code('EACCES'))
  })

  it('refuses a grant without the rights it needs and leaves the root unchanged', () => {
    const root = join(base, 'root')
    mkdirSync(join(root, 'src'), { recursive: true })
    icacls(root, '/inheritance:r', '/grant:r', `*${currentUserSid()}:(OI)(CI)M`, '*S-1-5-18:(OI)(CI)F')
    const before = inspectWindowsAcl(root)
    expect(() => applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid: writeSid() })).toThrow(
      code('EACCES'),
    )
    expect(inspectWindowsAcl(root).fingerprint).toBe(before.fingerprint)
  })

  it('grants, keeps every other entry, allows ordinary work and restores exactly', () => {
    const root = workspace()
    const before = inspectWindowsAcl(root)
    expect(before.descendants.map(({ path }) => basename(path))).toContain('own')
    expect(before.inheritedDescendants).toBeGreaterThanOrEqual(2)
    const sid = writeSid()
    const { result, root: change } = grant(before, sid)
    expect(result.failures).toEqual([])
    expect(result.complete).toBe(true)
    expect(change?.added).toHaveLength(3)
    expect(change?.added).toEqual(expect.arrayContaining([...windowsAclGrantEntries(sid)]))
    expect(change?.removed).toEqual([])
    // A directory below the root inherits all three entries (0x10 marks them inherited).
    const own = result.changes.find(({ path }) => basename(path) === 'own')
    expect(own?.added).toHaveLength(3)
    expect(own?.added).toEqual(
      expect.arrayContaining([
        { kind: 'allow', sid, mask: 0x110156, flags: 0x13 },
        { kind: 'deny', sid: 'S-1-1-0', mask: 0x40, flags: 0x12 },
        { kind: 'label', sid: 'S-1-16-4096', mask: 0x01, flags: 0x13 },
      ]),
    )
    expect(own?.removed).toEqual([])

    const granted = inspectWindowsAcl(root)
    expect(granted.fingerprint).toBe(change?.afterFingerprint)
    for (const ace of aces(before.securityDescriptor)) expect(granted.securityDescriptor).toContain(ace)
    const grantedOwn = granted.descendants.find(({ path }) => basename(path) === 'own')
    const beforeOwn = before.descendants.find(({ path }) => basename(path) === 'own')
    for (const ace of aces(beforeOwn?.securityDescriptor ?? '').filter((ace) => !ace.includes('ID;')))
      expect(grantedOwn?.securityDescriptor).toContain(ace)

    for (const directory of [root, join(root, 'own'), join(root, 'src')]) {
      const file = join(directory, 'new.txt')
      writeFileSync(file, 'one')
      appendFileSync(file, 'two')
      expect(readFileSync(file, 'utf8')).toBe('onetwo')
      renameSync(file, join(directory, 'renamed.txt'))
      rmSync(join(directory, 'renamed.txt'))
      mkdirSync(join(directory, 'made'))
      writeFileSync(join(directory, 'made', 'x'), 'x')
      rmSync(join(directory, 'made'), { recursive: true })
    }
    expect(inspectWindowsAcl(root).fingerprint).toBe(change?.afterFingerprint)

    const restored = restoreWindowsAclGrant({
      before,
      grantId: 'grant-1',
      expectedCurrentFingerprint: change?.afterFingerprint ?? '',
      removableChanges: change?.added ?? [],
    })
    expect(restored.failures).toEqual([])
    expect(restored.complete).toBe(true)
    const after = inspectWindowsAcl(root)
    expect(after.fingerprint).toBe(before.fingerprint)
    expect(after.securityDescriptor).not.toContain(sid)
    const now = new Map(after.descendants.map((item) => [key(item), item]))
    for (const item of before.descendants)
      expect(now.get(key(item))?.securityDescriptor).toBe(item.securityDescriptor)
  })

  it('keeps an entry another grant shares when only the exclusive ones are removed', () => {
    const root = workspace()
    const first = grant(inspectWindowsAcl(root), writeSid())
    const second = grant(inspectWindowsAcl(root), writeSid())
    expect(second.result.complete).toBe(true)
    // The deny and the label already stood, so the second grant only added its own allow entry.
    expect(second.root?.added.map(({ kind }) => kind)).toEqual(['allow'])
    const restored = restoreWindowsAclGrant({
      before: inspectWindowsAcl(root),
      grantId: 'grant-2',
      expectedCurrentFingerprint: second.root?.afterFingerprint ?? '',
      removableChanges: second.root?.added ?? [],
    })
    expect(restored.complete).toBe(true)
    const after = inspectWindowsAcl(root)
    expect(after.fingerprint).toBe(first.root?.afterFingerprint)
  })

  it('reaches a hard-linked file through every name and takes the grant back from all of them', () => {
    const root = join(base, 'root')
    mkdirSync(root)
    const outside = join(base, 'outside.txt')
    writeFileSync(outside, 'shared')
    linkSync(outside, join(root, 'alias.txt'))
    const before = inspectWindowsAcl(root)
    expect(before.descendants).toEqual([])
    const sid = writeSid()
    const { result, root: change } = grant(before, sid)
    expect(result.complete).toBe(true)
    // One descriptor serves both names, so the grant is visible through the outside name too.
    expect(execFileSync('icacls', [outside], { encoding: 'utf8' })).toContain(sid)
    const restored = restoreWindowsAclGrant({
      before,
      grantId: 'grant-1',
      expectedCurrentFingerprint: change?.afterFingerprint ?? '',
      removableChanges: change?.added ?? [],
    })
    expect(restored.complete).toBe(true)
    expect(execFileSync('icacls', [outside], { encoding: 'utf8' })).not.toContain(sid)
  })

  it('refuses to write over a concurrent ACL change', () => {
    const root = workspace()
    const stale = inspectWindowsAcl(root)
    icacls(root, '/grant', '*S-1-5-32-546:(RX)')
    const sid = writeSid()
    expect(() => applyWindowsAclGrant({ before: stale, grantId: 'grant-1', writeSid: sid })).toThrow(
      code('E_ACL_CHANGED'),
    )
    expect(inspectWindowsAcl(root).securityDescriptor).not.toContain(sid)

    const before = inspectWindowsAcl(root)
    icacls(join(root, 'src', 'a.txt'), '/grant', '*S-1-5-32-546:(R)')
    expect(() => applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid: sid })).toThrow(
      code('E_ACL_CHANGED'),
    )
    expect(inspectWindowsAcl(root).securityDescriptor).not.toContain(sid)

    const { root: change } = grant(inspectWindowsAcl(root), sid)
    icacls(root, '/grant', '*S-1-5-32-547:(RX)')
    const changed = inspectWindowsAcl(root)
    expect(() =>
      restoreWindowsAclGrant({
        before: changed,
        grantId: 'grant-1',
        expectedCurrentFingerprint: change?.afterFingerprint ?? '',
        removableChanges: change?.added ?? [],
      }),
    ).toThrow(code('E_ACL_CHANGED'))
    expect(inspectWindowsAcl(root).securityDescriptor).toContain(sid)
  })
})
