// In-memory stand-ins for the Windows ACL primitives and the Host platform, for the authority's
// tests on any OS, with this OS's own path rules. Directories are real (under a temporary
// directory) so canonical paths, links and the journal behave as on disk; permissions are modelled
// per directory as SDDL entry lists.
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { acquireOwnerFileLock } from '@agnes/system-node/owner-lock'
import type {
  WindowsAclApply,
  WindowsAclEntry,
  WindowsAclMutation,
  WindowsAclRestore,
  WindowsAclSnapshot,
  WindowsObjectIdentity,
} from '@agnes/system-node/windows-acl'
import { windowsAclFingerprint } from '@agnes/system-node/windows-acl'
import type { ProcessIdentity } from '../../src/adapters/process-identity.js'
import {
  claimWindowsLaunchPermit,
  type WindowsAclLaunchClaim,
  type WindowsAclNative,
  type WindowsAclPlatform,
  WindowsExecutionAuthority,
  type WindowsExecutionLease,
} from '../../src/windows-acl/authority.js'
import {
  durableStateFiles,
  type WindowsAclStateFiles,
  type WindowsGrantRecord,
} from '../../src/windows-acl/journal.js'

type FakeObject = { identity: WindowsObjectIdentity; dacl: string[]; label: string[] }

const ALLOW_MASK = 0x110156
const allowAce = (sid: string) => `(A;OICI;0x110156;;;${sid})`
const DENY_ACE = '(D;CI;DC;;;WD)'
const LABEL_ACE = '(ML;OICI;NW;;;LW)'
const crashError = () => Object.assign(new Error('simulated process death'), { code: 'E_TEST_CRASH' })

export const identityOf = (): WindowsObjectIdentity => ({
  volumeId: randomBytes(8).toString('hex'),
  fileId: randomBytes(16).toString('hex'),
})

/** Models NTFS permissions of directories; counts every native call like a mutation spy would. */
export class FakeNtfs implements WindowsAclNative {
  readonly calls = { inspect: 0, apply: 0, restore: 0 }
  readonly objects = new Map<string, FakeObject>()
  /** Runs inside apply before anything changes; throwing simulates a refusal or a crash there. */
  beforeApply?: (input: WindowsAclApply) => void
  /** Runs once apply has computed its result, before the caller reads anything back. */
  afterApply?: (path: string) => void
  /** How apply ends: normally, after only the allow entry was written, or reporting incomplete. */
  applyOutcome: 'complete' | 'crash-after-allow' | 'crash-after-write' | 'incomplete' = 'complete'
  restoreOutcome: 'complete' | 'crash-after-write' = 'complete'

  directory(path: string): WindowsObjectIdentity {
    mkdirSync(path, { recursive: true })
    const object = { identity: identityOf(), dacl: ['(A;OICI;FA;;;SY)', '(A;OICI;FA;;;BA)'], label: [] }
    this.objects.set(realpathSync(path), object)
    return object.identity
  }

  forget(path: string): void {
    this.objects.delete(path)
  }

  sddl(path: string): string {
    const object = this.#object(path)
    return `O:BAG:BAD:AI${object.dacl.join('')}S:${object.label.join('')}`
  }

  thirdPartyChange(path: string): void {
    this.#object(path).dacl.push('(A;OICI;FA;;;S-1-5-21-1-2-3-1001)')
  }

  /** Another directory takes the path: same name, new identity, default permissions. */
  replace(path: string): void {
    this.objects.set(path, { identity: identityOf(), dacl: ['(A;OICI;FA;;;SY)'], label: [] })
  }

  identity(path: string): WindowsObjectIdentity {
    return this.#object(path).identity
  }

  inspect(path: string): WindowsAclSnapshot {
    this.calls.inspect++
    const object = this.#object(path)
    const securityDescriptor = this.sddl(path)
    return {
      path,
      identity: object.identity,
      securityDescriptor,
      fingerprint: windowsAclFingerprint(object.identity, securityDescriptor),
      descendants: [],
      inheritedDescendants: 0,
    }
  }

  apply(input: WindowsAclApply): WindowsAclMutation {
    this.calls.apply++
    this.beforeApply?.(input)
    const object = this.#object(input.before.path)
    if (object.identity.fileId !== input.before.identity.fileId)
      throw Object.assign(new Error('identity'), { code: 'E_ACL_IDENTITY_MISMATCH' })
    if (this.inspect(input.before.path).fingerprint !== input.before.fingerprint)
      throw Object.assign(new Error('changed'), { code: 'E_ACL_CHANGED' })
    const beforePrint = input.before.fingerprint
    const added: WindowsAclEntry[] = [{ kind: 'allow', sid: input.writeSid, mask: ALLOW_MASK, flags: 0x03 }]
    object.dacl.push(allowAce(input.writeSid))
    if (this.applyOutcome === 'crash-after-allow') throw crashError()
    if (!object.dacl.includes(DENY_ACE)) {
      object.dacl.unshift(DENY_ACE)
      added.push({ kind: 'deny', sid: 'S-1-1-0', mask: 0x40, flags: 0x02 })
    }
    if (!object.label.includes(LABEL_ACE)) {
      object.label.unshift(LABEL_ACE)
      added.push({ kind: 'label', sid: 'S-1-16-4096', mask: 0x01, flags: 0x03 })
    }
    if (this.applyOutcome === 'crash-after-write') throw crashError()
    const after = this.inspect(input.before.path)
    const incomplete = this.applyOutcome === 'incomplete'
    this.afterApply?.(input.before.path)
    return {
      grantId: input.grantId,
      complete: !incomplete,
      changes: [
        {
          path: after.path,
          identity: after.identity,
          beforeFingerprint: beforePrint,
          afterFingerprint: after.fingerprint,
          added,
          removed: [],
        },
      ],
      failures: incomplete
        ? [{ path: `${after.path}/child`, code: 'E_ACL_PROPAGATION_INCOMPLETE', win32Code: 5 }]
        : [],
      inheritedDescendants: 0,
    }
  }

  restore(input: WindowsAclRestore): WindowsAclMutation {
    this.calls.restore++
    const object = this.#object(input.before.path)
    const now = this.inspect(input.before.path)
    if (now.fingerprint !== input.expectedCurrentFingerprint)
      throw Object.assign(new Error('changed'), { code: 'E_ACL_CHANGED' })
    const remove = (list: string[], ace: string) => {
      const index = list.indexOf(ace)
      if (index < 0) throw Object.assign(new Error('entry gone'), { code: 'E_ACL_CHANGED' })
      list.splice(index, 1)
    }
    const dacl = [...object.dacl],
      label = [...object.label]
    for (const entry of input.removableChanges)
      if (entry.kind === 'allow') remove(dacl, allowAce(entry.sid))
      else if (entry.kind === 'deny') remove(dacl, DENY_ACE)
      else remove(label, LABEL_ACE)
    object.dacl = dacl
    object.label = label
    if (this.restoreOutcome === 'crash-after-write') throw crashError()
    const after = this.inspect(input.before.path)
    return {
      grantId: input.grantId,
      complete: true,
      changes: [
        {
          path: after.path,
          identity: after.identity,
          beforeFingerprint: now.fingerprint,
          afterFingerprint: after.fingerprint,
          added: [],
          removed: input.removableChanges,
        },
      ],
      failures: [],
      inheritedDescendants: 0,
    }
  }

  #object(path: string): FakeObject {
    const object = this.objects.get(path)
    if (!object) throw Object.assign(new Error(`no such directory: ${path}`), { code: 'ENOENT' })
    return object
  }
}

export type FakeHost = WindowsAclPlatform & { processes: Map<number, ProcessIdentity> }

/** A Host process on this machine. Other Hosts get their own pid and start identity. */
export function fakePlatform(ntfs: FakeNtfs, pid = 4242): FakeHost {
  const processes = new Map<number, ProcessIdentity>()
  const self = { pid, startId: `test:${pid}:${randomBytes(4).toString('hex')}` }
  processes.set(pid, { state: 'alive', startId: self.startId })
  return {
    processes,
    self,
    paths: { basename, dirname, isAbsolute, join, relative, caseInsensitive: false },
    async canonicalPath(path) {
      return realpathSync(path)
    },
    async rootIdentity(path) {
      return ntfs.identity(path)
    },
    async ensurePrivateDirectory(path) {
      mkdirSync(path, { recursive: true, mode: 0o700 })
      const stat = lstatSync(path)
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
        throw Object.assign(new Error(`${path} is not private`), { code: 'E_ACL_STATE_UNSAFE' })
    },
    async createDirectory(path) {
      mkdirSync(path)
      ntfs.directory(path)
    },
    async removeDirectory(path) {
      rmSync(path, { recursive: true, force: true })
      ntfs.forget(path)
    },
    async processIdentity(target) {
      return processes.get(target) ?? { state: 'dead' }
    },
  }
}

/** Real durable files whose writes can be made to fail, all at once after a crash point. */
export class FaultyFiles implements WindowsAclStateFiles {
  writes = 0
  /** Fails this write (1-based) and every write after it, as a dead process would. */
  failFrom = Number.POSITIVE_INFINITY
  /** Fails when the predicate matches the record about to be written. */
  failWhen?: (path: string, text: string) => boolean

  read(path: string) {
    return durableStateFiles.read(path)
  }
  list(directory: string) {
    return durableStateFiles.list(directory)
  }
  writeDurable(path: string, text: string) {
    this.writes++
    if (this.writes >= this.failFrom || this.failWhen?.(path, text))
      throw Object.assign(new Error('flush failed'), { code: 'EIO' })
    durableStateFiles.writeDurable(path, text)
  }
  removeDurable(path: string) {
    if (this.writes >= this.failFrom) throw Object.assign(new Error('flush failed'), { code: 'EIO' })
    durableStateFiles.removeDurable(path)
  }
}

export type AclWorld = Readonly<{
  base: string
  ntfs: FakeNtfs
  workspace: string
  stateRoot: string
  tempRoot: string
  home: string
}>

/** A workspace plus the Host's state, temp and private home directories, all under `base`. */
export function aclWorld(base: string): AclWorld {
  const ntfs = new FakeNtfs()
  const workspace = join(base, 'work')
  ntfs.directory(workspace)
  return {
    base,
    ntfs,
    workspace,
    stateRoot: join(base, 'state'),
    tempRoot: join(base, 'temp'),
    home: join(base, 'home'),
  }
}

export type AclHost = Readonly<{
  authority: WindowsExecutionAuthority
  platform: FakeHost
  files: FaultyFiles
}>

export function aclHost(
  world: AclWorld,
  options: { pid?: number; tempRoot?: string; stateRoot?: string; privateRoots?: string[] } = {},
): AclHost {
  const platform = fakePlatform(world.ntfs, options.pid)
  const files = new FaultyFiles()
  const authority = new WindowsExecutionAuthority({
    stateRoot: options.stateRoot ?? world.stateRoot,
    tempRoot: options.tempRoot ?? world.tempRoot,
    privateRoots: options.privateRoots ?? [world.home],
    native: world.ntfs,
    platform,
    files,
    lockWaitMs: 150,
  })
  return { authority, platform, files }
}

export const writeLease = (root: string, session = 'session-a') =>
  ({
    sessionExecutionId: session,
    canonicalRoot: root,
    policyDigest: 'policy-1',
    mode: 'workspace-write',
  }) as const

/** Counts business processes that actually got a permit through; each one exits at once. */
export class Launcher {
  count = 0
  async launch(lease: WindowsExecutionLease): Promise<WindowsAclLaunchClaim> {
    const claim = claimWindowsLaunchPermit(await lease.prepareLaunch())
    this.count++
    claim.started(Promise.resolve())
    return claim
  }
}

/** Grant records as they are on disk, without going through the journal's own reader. */
export function recordsOnDisk(stateRoot: string): WindowsGrantRecord[] {
  const directory = join(stateRoot, 'grants')
  return durableStateFiles
    .list(directory)
    .filter((name) => !name.endsWith('.tmp'))
    .map((name) => JSON.parse((durableStateFiles.read(join(directory, name)) ?? '').slice(65)))
}

/** The lock a Host that died while holding it leaves behind. */
export function leaveLock(stateRoot: string, pid: number): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  acquireOwnerFileLock(join(stateRoot, 'lock'), { pid, startId: `dead:${pid}`, token: `token-${pid}` })
}
