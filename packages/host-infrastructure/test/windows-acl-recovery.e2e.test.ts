// The Windows execution authority on real NTFS: grants, interrupted grants, two Hosts sharing one
// journal and nested roots, with the native ACL primitives and real process identities. Directories
// are synthetic, under the system temporary directory.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { hasPrivateDaclSync, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import {
  applyWindowsAclGrant,
  inspectWindowsAcl,
  restoreWindowsAclGrant,
} from '@agnes/system-node/windows-acl'
import { createWindowsAclWorker } from '@agnes/system-node/windows-acl-worker'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { windowsProcessIdentity } from '../src/adapters/process-identity-win32.js'
import {
  claimWindowsLaunchPermit,
  type WindowsAclNative,
  type WindowsAclPlatform,
  WindowsExecutionAuthority,
} from '../src/windows-acl/authority.js'
import type { WindowsAclStateFiles } from '../src/windows-acl/journal.js'
import { FaultyFiles, leaveLock, writeLease } from './fixtures/windows-acl-fakes.js'

const realNative: WindowsAclNative = {
  inspect: inspectWindowsAcl,
  apply: applyWindowsAclGrant,
  restore: restoreWindowsAclGrant,
}

async function hostPlatform(pid = process.pid): Promise<WindowsAclPlatform> {
  const identity = await windowsProcessIdentity(pid)
  if (identity.state !== 'alive') throw new Error(`process ${pid} is not running`)
  return {
    paths: { ...win32, caseInsensitive: true },
    canonicalPath: async (path) => realpathSync.native(path),
    // Reads the identity through a full inspection; enough for tests, slower than the Host needs.
    rootIdentity: async (path) => inspectWindowsAcl(path).identity,
    ensurePrivateDirectory: async (path) => {
      windowsEnsurePrivateDirectorySync(path)
      if (lstatSync(path).isSymbolicLink() || !hasPrivateDaclSync(path))
        throw Object.assign(new Error(`${path} is not private`), { code: 'E_ACL_STATE_UNSAFE' })
    },
    createDirectory: async (path) => mkdirSync(path),
    removeDirectory: async (path) => rmSync(path, { recursive: true, force: true, maxRetries: 5 }),
    self: { pid, startId: identity.startId },
    processIdentity: windowsProcessIdentity,
  }
}

let base = ''
const children: { kill(): boolean }[] = []
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-acl-recovery-')))
})
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  try {
    execFileSync('icacls', [base, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' })
  } catch {}
  rmSync(base, { recursive: true, force: true, maxRetries: 5 })
})

const code = (expected: string) => expect.objectContaining({ code: expected })
const sddl = (path: string) => inspectWindowsAcl(path).securityDescriptor
const directory = (...parts: string[]) => {
  const path = join(base, ...parts)
  mkdirSync(path, { recursive: true })
  return realpathSync.native(path)
}

async function authorityFor(
  options: { pid?: number; files?: WindowsAclStateFiles; native?: WindowsAclNative } = {},
) {
  return new WindowsExecutionAuthority({
    stateRoot: join(base, 'state'),
    tempRoot: join(base, 'acl-temp'),
    privateRoots: [join(base, 'home')],
    native: options.native ?? realNative,
    platform: await hostPlatform(options.pid),
    ...(options.files ? { files: options.files } : {}),
    lockWaitMs: 2_000,
  })
}

async function repairFully(authority: WindowsExecutionAuthority, root: string) {
  const report = await authority.inspect(root)
  return authority.repair({
    root,
    grantId: report.grantId ?? '',
    expectedRecordDigest: report.recordDigest ?? '',
  })
}

/** A process that stays alive until stopped, standing in for another Host. */
function otherHost(): { pid: number; stop(): Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  const { pid } = child
  if (!pid) throw new Error('could not start the stand-in Host')
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return {
    pid,
    stop: async () => {
      child.kill()
      await exited
    },
  }
}

describe.skipIf(process.platform !== 'win32')('Windows execution authority on NTFS', () => {
  it('grants once, keeps the workspace grant standing after close and repairs to the original', async () => {
    const workspace = directory('work')
    writeFileSync(join(workspace, 'file.txt'), 'x')
    const original = inspectWindowsAcl(workspace).fingerprint
    const authority = await authorityFor()
    const lease = await authority.acquire(writeLease(workspace))
    const claim = claimWindowsLaunchPermit(await lease.prepareLaunch())
    const [workspaceSid, tempSid] = claim.writeSids
    expect(sddl(workspace)).toContain(workspaceSid)
    expect(sddl(lease.tempRoot ?? '')).toContain(tempSid)
    claim.started(Promise.resolve())
    await lease.close()
    expect(() => lstatSync(lease.tempRoot ?? '')).toThrow()
    expect(sddl(workspace)).toContain(workspaceSid)
    expect(await authority.inspect(workspace)).toMatchObject({ state: 'active' })
    expect((await repairFully(authority, workspace)).state).toBe('revoked')
    expect(inspectWindowsAcl(workspace).fingerprint).toBe(original)
  })

  it('an interrupted grant needs attention after a restart and repairs to the original', async () => {
    const workspace = directory('work')
    const original = inspectWindowsAcl(workspace).fingerprint
    const files = new FaultyFiles()
    const dying: WindowsAclNative = {
      ...realNative,
      apply: (input) => {
        const result = applyWindowsAclGrant(input)
        files.failFrom = files.writes + 1
        throw Object.assign(new Error('simulated process death'), { code: 'E_TEST_CRASH', result })
      },
    }
    await expect(
      (await authorityFor({ files, native: dying })).acquire(writeLease(workspace)),
    ).rejects.toThrow(code('E_TEST_CRASH'))
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    leaveLock(join(base, 'state'), exited)
    const restarted = await authorityFor()
    await expect(restarted.acquire(writeLease(workspace))).rejects.toThrow(code('E_ACL_NEEDS_ATTENTION'))
    expect((await restarted.inspect(workspace)).state).toBe('needs-attention')
    const repaired = await repairFully(restarted, workspace)
    // The result was never recorded, so the deny and label may remain for the user to check.
    expect(['revoked', 'needs-attention']).toContain(repaired.state)
    expect(sddl(workspace)).not.toMatch(/S-1-4-/)
    if (repaired.state === 'revoked') expect(inspectWindowsAcl(workspace).fingerprint).toBe(original)
  })

  it('a second Host using the grant blocks repair until it is proven gone', async () => {
    const workspace = directory('work')
    const original = inspectWindowsAcl(workspace).fingerprint
    const host = otherHost()
    const other = await authorityFor({ pid: host.pid })
    const theirs = await other.acquire(writeLease(workspace, 'session-other'))
    const ours = await authorityFor()
    const mine = await ours.acquire(writeLease(workspace))
    const mineClaim = claimWindowsLaunchPermit(await mine.prepareLaunch())
    const theirsClaim = claimWindowsLaunchPermit(await theirs.prepareLaunch())
    expect(mineClaim.writeSids[0]).toBe(theirsClaim.writeSids[0])
    expect(mineClaim.writeSids[1]).not.toBe(theirsClaim.writeSids[1])
    mineClaim.started(Promise.resolve())
    theirsClaim.started(Promise.resolve())
    await mine.close()
    expect((await repairFully(ours, workspace)).issues[0]?.reason).toMatch(/^in-use/)
    await host.stop()
    expect((await repairFully(ours, workspace)).state).toBe('revoked')
    expect(inspectWindowsAcl(workspace).fingerprint).toBe(original)
    // The gone Host's temp is released by the next grant transaction, not by its age.
    await ours.acquire(writeLease(directory('elsewhere')))
    expect(() => lstatSync(theirs.tempRoot ?? '')).toThrow()
  })

  it('nested roots keep their own grants: repairing the inner one leaves the outer one working', async () => {
    const outer = directory('work')
    const inner = directory('work', 'inner')
    const originals = [inspectWindowsAcl(outer).fingerprint, inspectWindowsAcl(inner).fingerprint]
    const authority = await authorityFor()
    await (await authority.acquire(writeLease(outer))).close()
    await (await authority.acquire(writeLease(inner))).close()
    expect((await repairFully(authority, inner)).state).toBe('revoked')
    expect(await authority.inspect(outer)).toMatchObject({ state: 'active' })
    const lease = await authority.acquire(writeLease(outer))
    claimWindowsLaunchPermit(await lease.prepareLaunch()).abandoned()
    await lease.close()
    expect((await repairFully(authority, outer)).state).toBe('revoked')
    expect([inspectWindowsAcl(outer).fingerprint, inspectWindowsAcl(inner).fingerprint]).toEqual(originals)
  })

  it('nested roots granted inner first: the outer grant and its repair leave the inner one working', async () => {
    const outer = directory('work')
    const inner = directory('work', 'inner')
    const originals = [inspectWindowsAcl(outer).fingerprint, inspectWindowsAcl(inner).fingerprint]
    // The Host runs the tree walks on a worker thread; so does this case.
    const worker = createWindowsAclWorker()
    try {
      const authority = await authorityFor({ native: worker })
      const innerLease = await authority.acquire(writeLease(inner, 'session-inner'))
      claimWindowsLaunchPermit(await innerLease.prepareLaunch()).abandoned()
      const innerOwned = inspectWindowsAcl(inner).ownedFingerprint
      const outerLease = await authority.acquire(writeLease(outer, 'session-outer'))
      // The outer grant changed what the inner root inherits, not what its own grant made.
      expect(inspectWindowsAcl(inner).ownedFingerprint).toBe(innerOwned)
      claimWindowsLaunchPermit(await innerLease.prepareLaunch()).abandoned()
      const again = await authority.acquire(writeLease(inner, 'session-inner-2'))
      claimWindowsLaunchPermit(await again.prepareLaunch()).abandoned()
      expect(await authority.inspect(inner)).toMatchObject({ state: 'active', issues: [] })
      await outerLease.close()
      expect((await repairFully(authority, outer)).state).toBe('revoked')
      claimWindowsLaunchPermit(await innerLease.prepareLaunch()).abandoned()
      expect(await authority.inspect(inner)).toMatchObject({ state: 'active', issues: [] })
      await innerLease.close()
      await again.close()
      expect((await repairFully(authority, inner)).state).toBe('revoked')
      expect([inspectWindowsAcl(outer).fingerprint, inspectWindowsAcl(inner).fingerprint]).toEqual(originals)
    } finally {
      await worker.close()
    }
  })

  it('records how long a larger tree takes to grant and repair', async () => {
    const workspace = directory('work')
    for (let folder = 0; folder < 40; folder++) {
      const path = join(workspace, `folder-${folder}`)
      mkdirSync(path)
      for (let file = 0; file < 50; file++) writeFileSync(join(path, `file-${file}.txt`), 'x')
    }
    const authority = await authorityFor()
    const started = performance.now()
    await (await authority.acquire(writeLease(workspace))).close()
    const granted = performance.now()
    expect((await repairFully(authority, workspace)).state).toBe('revoked')
    console.info(
      `windows-acl: 2000 files granted in ${Math.round(granted - started)} ms, repaired in ${Math.round(performance.now() - granted)} ms`,
    )
  })
})
