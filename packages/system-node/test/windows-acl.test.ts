// Argument validation, the off-Windows contract and the mapping of native results. The native
// binding is replaced by a fake here; real NTFS behaviour is covered by windows-acl.e2e.test.ts.
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

type AclModule = typeof import('../src/windows-acl.js')
type Snapshot = import('../src/windows-acl.js').WindowsAclSnapshot

const fake = vi.hoisted(() => ({
  loads: 0,
  present: true,
  testBuild: false,
  aclInspect: vi.fn(),
  aclApply: vi.fn(),
  aclRestore: vi.fn(),
  aclIdentity: vi.fn(),
}))

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  const binding = () =>
    new Proxy(
      { abiVersion: 1 },
      {
        get: (target, key) => {
          if (key === 'abiVersion') return target.abiVersion
          if (key === 'testFaults') return fake.testBuild ? true : undefined
          if (key === 'aclInspect' || key === 'aclApply' || key === 'aclRestore' || key === 'aclIdentity')
            return fake.present ? fake[key] : undefined
          return () => {}
        },
      },
    )
  return {
    ...actual,
    createRequire: (url: string) => {
      const real = actual.createRequire(url)
      return Object.assign((id: string) => {
        if (id !== '@agnes/system-node/native') return real(id)
        fake.loads++
        return binding()
      }, real)
    },
  }
})

const original = Object.getOwnPropertyDescriptor(process, 'platform')
async function load(platform: NodeJS.Platform): Promise<AclModule> {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try {
    return await import('../src/windows-acl.js')
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

afterEach(() => {
  fake.loads = 0
  fake.present = true
  fake.testBuild = false
  fake.aclInspect.mockReset()
  fake.aclApply.mockReset()
  fake.aclRestore.mockReset()
  fake.aclIdentity.mockReset()
})

const volumeId = '00000000a1b2c3d4'
const fileId = '00000000000000000001000000000abc'
const childId = '00000000000000000002000000000def'
const rootSddl = 'O:S-1-5-21-1-2-3-1001G:S-1-5-21-1-2-3-513D:AI(A;OICIID;FA;;;SY)'
const childSddl = 'O:S-1-5-21-1-2-3-1001G:S-1-5-21-1-2-3-513D:PAI(A;;FA;;;SY)'
const writeSid = 'S-1-4-123456-654321'
const owned = 'a'.repeat(64)
const ownedAfter = 'd'.repeat(64)
const print = (identity: { volumeId: string; fileId: string }, sddl: string): string =>
  createHash('sha256')
    .update(Buffer.from(`agnes-windows-acl-v1\n${identity.volumeId}\n${identity.fileId}\n${sddl}`, 'utf16le'))
    .digest('hex')

function snapshot(): Snapshot {
  const identity = { volumeId, fileId }
  const child = { volumeId, fileId: childId }
  return {
    path: 'C:\\Users\\me\\工作 区',
    identity,
    securityDescriptor: rootSddl,
    fingerprint: print(identity, rootSddl),
    ownedFingerprint: owned,
    descendants: [
      {
        path: 'C:\\Users\\me\\工作 区\\private',
        identity: child,
        securityDescriptor: childSddl,
        fingerprint: print(child, childSddl),
      },
    ],
    inheritedDescendants: 12,
  }
}
const code = (expected: string) => expect.objectContaining({ code: expected })

describe('Windows ACL arguments', () => {
  it.each([
    ['empty', ''],
    ['relative', 'workspace\\project'],
    ['drive-relative', 'C:project'],
    ['UNC', '\\\\server\\share\\project'],
    ['namespaced', '\\\\?\\C:\\project'],
    ['device', '\\\\.\\C:\\project'],
    ['NUL', 'C:\\pro\0ject'],
    ['stream', 'C:\\project:stream'],
  ])('rejects a %s root path', async (_name, path) => {
    const acl = await load('win32')
    expect(() => acl.inspectWindowsAcl(path)).toThrow(code('EINVAL'))
    expect(() => acl.inspectWindowsAcl(42 as unknown as string)).toThrow(code('EINVAL'))
    expect(fake.loads).toBe(0)
  })

  it.each(['C:\\', 'c:/', 'D:\\.', 'E:\\project\\..'])('refuses the drive root %s', async (path) => {
    const acl = await load('win32')
    expect(() => acl.inspectWindowsAcl(path)).toThrow(code('E_ACL_DRIVE_ROOT'))
    expect(fake.loads).toBe(0)
  })

  it('rejects a grant identity, write SID or snapshot it cannot trust', async () => {
    const acl = await load('win32')
    const before = snapshot()
    const apply = (input: Record<string, unknown>) =>
      acl.applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid, ...input } as never)
    for (const grantId of ['', 'has space', 'x'.repeat(129), '-leading'])
      expect(() => apply({ grantId })).toThrow(code('EINVAL'))
    for (const sid of [
      'S-1-5-32-544',
      'S-1-1-0',
      'S-1-4',
      'S-1-4-01',
      'S-1-4-4294967296',
      `S-1-4${'-1'.repeat(16)}`,
      's-1-4-1',
    ])
      expect(() => apply({ writeSid: sid })).toThrow(code('EINVAL'))
    const tampered = { ...before, securityDescriptor: `${rootSddl}(A;;FA;;;WD)` }
    expect(() => apply({ before: tampered })).toThrow(code('EINVAL'))
    const upper = { ...before, identity: { volumeId: volumeId.toUpperCase(), fileId } }
    expect(() => apply({ before: upper })).toThrow(code('EINVAL'))
    const duplicate = { ...before, descendants: [...before.descendants, ...before.descendants] }
    expect(() => apply({ before: duplicate })).toThrow(code('EINVAL'))
    const rootAgain = {
      ...before,
      descendants: [{ ...before, path: `${before.path}\\again` }].map(
        ({ path, identity, securityDescriptor, fingerprint }) => ({
          path,
          identity,
          securityDescriptor,
          fingerprint,
        }),
      ),
    }
    expect(() => apply({ before: rootAgain })).toThrow(code('EINVAL'))
    expect(() => apply({ before: { ...before, inheritedDescendants: -1 } })).toThrow(code('EINVAL'))
    expect(() => apply({ before: { ...before, path: 'C:\\' } })).toThrow(code('E_ACL_DRIVE_ROOT'))
    expect(fake.aclApply).not.toHaveBeenCalled()
  })

  it('accepts only the exact entries a grant adds for removal', async () => {
    const acl = await load('win32')
    const before = snapshot()
    const [allow, deny, label] = acl.windowsAclGrantEntries(writeSid)
    const restore = (input: Record<string, unknown>) =>
      acl.restoreWindowsAclGrant({
        before,
        grantId: 'grant-1',
        expectedCurrentFingerprint: 'a'.repeat(64),
        removableChanges: [allow],
        ...input,
      } as never)
    expect(() => restore({ removableChanges: [] })).toThrow(code('EINVAL'))
    expect(() => restore({ removableChanges: [allow, allow] })).toThrow(code('EINVAL'))
    expect(() => restore({ removableChanges: [{ ...deny, mask: 0x10000 }] })).toThrow(code('EINVAL'))
    expect(() => restore({ removableChanges: [{ ...label, flags: 0x13 }] })).toThrow(code('EINVAL'))
    expect(() => restore({ removableChanges: [{ ...allow, sid: 'S-1-5-11' }] })).toThrow(code('EINVAL'))
    expect(() => restore({ removableChanges: [{ ...allow, kind: 'other' }] })).toThrow(code('EINVAL'))
    for (const expectedCurrentFingerprint of ['', 'A'.repeat(64), 'a'.repeat(63)])
      expect(() => restore({ expectedCurrentFingerprint })).toThrow(code('EINVAL'))
    expect(fake.aclRestore).not.toHaveBeenCalled()
  })

  it('describes the three entries a grant adds', async () => {
    const acl = await load('win32')
    expect(acl.windowsAclGrantEntries(writeSid)).toEqual([
      { kind: 'allow', sid: writeSid, mask: 0x110156, flags: 0x03 },
      { kind: 'deny', sid: 'S-1-1-0', mask: 0x40, flags: 0x02 },
      { kind: 'label', sid: 'S-1-16-4096', mask: 0x01, flags: 0x03 },
    ])
    expect(() => acl.windowsAclGrantEntries('S-1-5-18')).toThrow(code('EINVAL'))
  })

  it('binds the fingerprint to the object identity as well as its descriptor', async () => {
    const acl = await load('win32')
    const identity = { volumeId, fileId }
    expect(acl.windowsAclFingerprint(identity, rootSddl)).toBe(print(identity, rootSddl))
    expect(acl.windowsAclFingerprint({ volumeId, fileId: childId }, rootSddl)).not.toBe(
      print(identity, rootSddl),
    )
    expect(() => acl.windowsAclFingerprint({ volumeId: 'x', fileId }, rootSddl)).toThrow(code('EINVAL'))
    expect(() => acl.windowsAclFingerprint(identity, '')).toThrow(code('EINVAL'))
  })
})

describe('Windows ACL off Windows', () => {
  it.each(['darwin', 'linux'] as const)(
    'reports ENOSYS on %s without loading the native module',
    async (os) => {
      const acl = await load(os)
      const before = snapshot()
      const [allow] = acl.windowsAclGrantEntries(writeSid)
      expect(() => acl.inspectWindowsAcl('C:\\Users\\me\\project')).toThrow(code('ENOSYS'))
      expect(() => acl.applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid })).toThrow(code('ENOSYS'))
      expect(() =>
        acl.restoreWindowsAclGrant({
          before,
          grantId: 'grant-1',
          expectedCurrentFingerprint: 'a'.repeat(64),
          removableChanges: allow ? [allow] : [],
        }),
      ).toThrow(code('ENOSYS'))
      expect(() => acl.readWindowsObjectIdentity('C:\\Users\\me\\project')).toThrow(code('ENOSYS'))
      expect(fake.loads).toBe(0)
    },
  )

  it('is exported from the package entry point', async () => {
    const entry = await import('@agnes/system-node/windows-acl')
    expect(typeof entry.inspectWindowsAcl).toBe('function')
    expect(typeof entry.applyWindowsAclGrant).toBe('function')
    expect(typeof entry.restoreWindowsAclGrant).toBe('function')
    expect(typeof entry.readWindowsObjectIdentity).toBe('function')
  })
})

describe('Windows ACL native results', () => {
  const rawRoot = () => {
    const before = snapshot()
    return {
      path: before.path,
      volumeId,
      fileId,
      securityDescriptor: rootSddl,
      fingerprint: before.fingerprint,
      ownedFingerprint: owned,
      descendants: [
        {
          path: before.descendants[0]?.path,
          volumeId,
          fileId: childId,
          securityDescriptor: childSddl,
          fingerprint: before.descendants[0]?.fingerprint,
        },
      ],
      inheritedDescendants: 12,
    }
  }

  it('passes the namespaced root to the native inspection and maps its snapshot', async () => {
    const acl = await load('win32')
    fake.aclInspect.mockReturnValue(rawRoot())
    const result = acl.inspectWindowsAcl('C:\\Users\\me\\工作 区\\')
    expect(fake.aclInspect).toHaveBeenCalledWith('\\\\?\\C:\\Users\\me\\工作 区')
    expect(result).toEqual(snapshot())
    expect(Object.isFrozen(result.descendants)).toBe(true)
  })

  it('refuses a native snapshot whose fingerprint does not match its contents', async () => {
    const acl = await load('win32')
    fake.aclInspect.mockReturnValue({ ...rawRoot(), securityDescriptor: childSddl })
    expect(() => acl.inspectWindowsAcl('C:\\Users\\me\\project')).toThrow(code('E_SYSTEM_NATIVE_UNAVAILABLE'))
    fake.aclInspect.mockReturnValue({ ...rawRoot(), descendants: undefined })
    expect(() => acl.inspectWindowsAcl('C:\\Users\\me\\project')).toThrow(code('E_SYSTEM_NATIVE_UNAVAILABLE'))
    for (const ownedFingerprint of [undefined, 'A'.repeat(64), 'a'.repeat(63)]) {
      fake.aclInspect.mockReturnValue({ ...rawRoot(), ownedFingerprint })
      expect(() => acl.inspectWindowsAcl('C:\\Users\\me\\project')).toThrow(
        code('E_SYSTEM_NATIVE_UNAVAILABLE'),
      )
    }
  })

  it('reports the owned fingerprint of the root after a complete change', async () => {
    const acl = await load('win32')
    const before = snapshot()
    const result = { complete: true, changes: [], failures: [], inheritedDescendants: 0 }
    fake.aclApply.mockReturnValue({ ...result, ownedFingerprint: ownedAfter })
    expect(acl.applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid }).ownedFingerprint).toBe(
      ownedAfter,
    )
    // A complete change always read the root back; without its owned fingerprint it is malformed.
    fake.aclApply.mockReturnValue(result)
    expect(() => acl.applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid })).toThrow(
      code('E_SYSTEM_NATIVE_UNAVAILABLE'),
    )
    fake.aclApply.mockReturnValue({ ...result, complete: false })
    expect(acl.applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid })).not.toHaveProperty(
      'ownedFingerprint',
    )
  })

  it('passes native refusals through unchanged', async () => {
    const acl = await load('win32')
    const refusal = Object.assign(new Error('E_ACL_REPARSE: link'), { code: 'E_ACL_REPARSE', path: 'C:\\x' })
    fake.aclInspect.mockImplementation(() => {
      throw refusal
    })
    expect(() => acl.inspectWindowsAcl('C:\\x')).toThrow(refusal)
  })

  it('sends the expected root and descendant evidence to the native grant', async () => {
    const acl = await load('win32')
    const before = snapshot()
    fake.aclApply.mockReturnValue({
      complete: true,
      changes: [],
      failures: [],
      inheritedDescendants: 12,
      ownedFingerprint: ownedAfter,
    })
    expect(acl.applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid })).toEqual({
      grantId: 'grant-1',
      complete: true,
      changes: [],
      failures: [],
      inheritedDescendants: 12,
      ownedFingerprint: ownedAfter,
    })
    expect(fake.aclApply).toHaveBeenCalledWith(
      '\\\\?\\C:\\Users\\me\\工作 区',
      volumeId,
      fileId,
      before.fingerprint,
      [`${volumeId}:${childId}:${before.descendants[0]?.fingerprint}`],
      writeSid,
    )
  })

  it('never reports a mutation complete while a failure is listed', async () => {
    const acl = await load('win32')
    const before = snapshot()
    const [allow] = acl.windowsAclGrantEntries(writeSid)
    fake.aclApply.mockReturnValue({
      complete: true,
      changes: [
        {
          path: before.path,
          volumeId,
          fileId,
          beforeFingerprint: before.fingerprint,
          afterFingerprint: 'b'.repeat(64),
          added: [allow],
          removed: [],
        },
      ],
      failures: [
        {
          path: `${before.path}\\locked`,
          volumeId: '',
          fileId: '',
          code: 'E_ACL_VERIFY_FAILED',
          win32Code: 5,
        },
      ],
      inheritedDescendants: 3,
    })
    expect(acl.applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid })).toEqual({
      grantId: 'grant-1',
      complete: false,
      changes: [
        {
          path: before.path,
          identity: { volumeId, fileId },
          beforeFingerprint: before.fingerprint,
          afterFingerprint: 'b'.repeat(64),
          added: [allow],
          removed: [],
        },
      ],
      failures: [{ path: `${before.path}\\locked`, code: 'E_ACL_VERIFY_FAILED', win32Code: 5 }],
      inheritedDescendants: 3,
    })
    fake.aclApply.mockReturnValue({ complete: true, failures: [], inheritedDescendants: 0 })
    expect(() => acl.applyWindowsAclGrant({ before, grantId: 'grant-1', writeSid })).toThrow(
      code('E_SYSTEM_NATIVE_UNAVAILABLE'),
    )
  })

  it('removes only the requested grant entries', async () => {
    const acl = await load('win32')
    const before = snapshot()
    const [allow, , label] = acl.windowsAclGrantEntries(writeSid)
    fake.aclRestore.mockReturnValue({
      complete: true,
      changes: [],
      failures: [],
      inheritedDescendants: 0,
      ownedFingerprint: ownedAfter,
    })
    const result = acl.restoreWindowsAclGrant({
      before,
      grantId: 'grant-1',
      expectedCurrentFingerprint: 'c'.repeat(64),
      removableChanges: allow && label ? [label, allow] : [],
    })
    expect(result.complete).toBe(true)
    expect(fake.aclRestore).toHaveBeenCalledWith(
      '\\\\?\\C:\\Users\\me\\工作 区',
      volumeId,
      fileId,
      'c'.repeat(64),
      writeSid,
      false,
      true,
    )
  })

  it('refuses the test build of the native artifact', async () => {
    fake.testBuild = true
    const acl = await load('win32')
    expect(() => acl.readWindowsObjectIdentity('C:\\Users\\me\\project')).toThrow(
      code('E_SYSTEM_NATIVE_UNAVAILABLE'),
    )
    expect(fake.aclIdentity).not.toHaveBeenCalled()
  })

  it('reports a native artifact that predates the ACL primitives', async () => {
    fake.present = false
    const acl = await load('win32')
    expect(() => acl.inspectWindowsAcl('C:\\Users\\me\\project')).toThrow(code('E_SYSTEM_NATIVE_UNAVAILABLE'))
  })

  it('reads a root identity without inspecting its tree', async () => {
    const acl = await load('win32')
    fake.aclIdentity.mockReturnValue({ volumeId, fileId })
    const identity = acl.readWindowsObjectIdentity('C:\\Users\\me\\工作 区\\')
    expect(fake.aclIdentity).toHaveBeenCalledWith('\\\\?\\C:\\Users\\me\\工作 区')
    expect(fake.aclInspect).not.toHaveBeenCalled()
    expect(identity).toEqual({ volumeId, fileId })
    expect(Object.isFrozen(identity)).toBe(true)
  })

  it('validates identity paths and native identities', async () => {
    const acl = await load('win32')
    for (const path of ['', 'project', 'C:project', '\\\\server\\share\\x', 'C:\\a\0b', 'C:\\a:s'])
      expect(() => acl.readWindowsObjectIdentity(path)).toThrow(code('EINVAL'))
    expect(() => acl.readWindowsObjectIdentity('D:\\')).toThrow(code('E_ACL_DRIVE_ROOT'))
    expect(fake.loads).toBe(0)
    for (const raw of [
      undefined,
      {},
      { volumeId: 'x', fileId },
      { volumeId, fileId: fileId.toUpperCase() },
    ]) {
      fake.aclIdentity.mockReturnValue(raw)
      expect(() => acl.readWindowsObjectIdentity('C:\\x')).toThrow(code('E_SYSTEM_NATIVE_UNAVAILABLE'))
    }
    const refusal = Object.assign(new Error('E_ACL_REPARSE: link'), { code: 'E_ACL_REPARSE' })
    fake.aclIdentity.mockImplementation(() => {
      throw refusal
    })
    expect(() => acl.readWindowsObjectIdentity('C:\\x')).toThrow(refusal)
  })
})
