// Execution leases of the Windows execution authority: the private temp root, per-lease temp and
// SID, root overlap rules, launch permits and the close/dispose lifecycle.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimWindowsLaunchPermit, type WindowsAclLaunchPermit } from '../src/windows-acl/authority.js'
import {
  type AclWorld,
  aclHost,
  aclWorld,
  Launcher,
  recordsOnDisk,
  writeLease,
} from './fixtures/windows-acl-fakes.js'

let base = ''
let world: AclWorld
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'agh-acl-leases-')))
  world = aclWorld(base)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const code = (expected: string) => expect.objectContaining({ code: expected })
const grants = (kind: 'workspace' | 'temp') =>
  recordsOnDisk(world.stateRoot).filter((item) => item.kind === kind)
const deferred = () => {
  let resolve: () => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('private temp and per-lease identity', () => {
  it('uses one fixed private temp root with a random directory and SID per lease', async () => {
    const { authority } = aclHost(world)
    const launcher = new Launcher()
    const a = await authority.acquire(writeLease(world.workspace, 'session-a'))
    const b = await authority.acquire(writeLease(world.workspace, 'session-b'))
    expect(a.tempRoot && dirname(a.tempRoot)).toBe(world.tempRoot)
    expect(b.tempRoot && dirname(b.tempRoot)).toBe(world.tempRoot)
    expect(a.tempRoot).not.toBe(b.tempRoot)
    expect(lstatSync(world.tempRoot).mode & 0o077).toBe(0)
    const claimA = await launcher.launch(a)
    const claimB = await launcher.launch(b)
    expect(claimA.writeSids[0]).toBe(claimB.writeSids[0])
    expect(claimA.writeSids[1]).not.toBe(claimB.writeSids[1])
    expect(claimA.tempRoot).toBe(a.tempRoot)
    expect(grants('workspace')).toHaveLength(1)
  })

  it('reuses the standing workspace grant but never another lease temp', async () => {
    const { authority } = aclHost(world)
    const launcher = new Launcher()
    const first = await authority.acquire(writeLease(world.workspace))
    const firstClaim = await launcher.launch(first)
    await first.close()
    const second = await authority.acquire(writeLease(world.workspace))
    const secondClaim = await launcher.launch(second)
    expect(world.ntfs.calls.apply).toBe(3)
    expect(second.tempRoot).not.toBe(first.tempRoot)
    expect(secondClaim.writeSids[0]).toBe(firstClaim.writeSids[0])
    expect(secondClaim.writeSids[1]).not.toBe(firstClaim.writeSids[1])
  })

  it('a session working below the root still has the root granted', async () => {
    mkdirSync(join(world.workspace, 'sub'))
    const { authority } = aclHost(world)
    const lease = await authority.acquire(writeLease(world.workspace))
    expect(lease.rootIdentity).toEqual(world.ntfs.identity(world.workspace))
    expect(grants('workspace')).toMatchObject([{ root: world.workspace, state: 'active' }])
    const claim = await new Launcher().launch(lease)
    expect(claim.root).toBe(world.workspace)
  })

  it('returns a lease only once the grant reads back as applied', async () => {
    const { authority } = aclHost(world)
    world.ntfs.afterApply = (path) => world.ntfs.thirdPartyChange(path)
    const launcher = new Launcher()
    await expect(
      authority.acquire(writeLease(world.workspace)).then((lease) => launcher.launch(lease)),
    ).rejects.toThrow(code('E_ACL_VERIFY_FAILED'))
    expect(launcher.count).toBe(0)
    expect(grants('workspace').map((record) => record.state)).toEqual(['needs-attention'])
  })

  it('a read-only lease grants nothing and has no temp', async () => {
    const { authority } = aclHost(world)
    const lease = await authority.acquire({ ...writeLease(world.workspace), mode: 'read-only' })
    const claim = await new Launcher().launch(lease)
    expect(lease.tempRoot).toBeUndefined()
    expect(claim.writeSids).toEqual([])
    expect(world.ntfs.calls.apply).toBe(0)
    await lease.close()
  })
})

describe('roots that overlap Host directories', () => {
  it('refuses a workspace that contains or lies inside a Host directory', async () => {
    const { authority } = aclHost(world)
    for (const directory of [world.tempRoot, world.stateRoot, world.home])
      mkdirSync(directory, { recursive: true })
    for (const root of [base, world.tempRoot, join(world.stateRoot), world.home]) {
      world.ntfs.directory(root)
      await expect(authority.acquire(writeLease(root))).rejects.toThrow(code('E_ACL_ROOT_OVERLAP'))
    }
    const inner = join(world.home, 'projects', 'app')
    world.ntfs.directory(inner)
    await expect(authority.acquire(writeLease(inner))).rejects.toThrow(code('E_ACL_ROOT_OVERLAP'))
    expect(world.ntfs.calls.apply).toBe(0)
  })

  it('compares canonical paths, so a link cannot hide an overlap', async () => {
    const { authority } = aclHost(world)
    const link = join(base, 'link-to-base')
    symlinkSync(base, link)
    await expect(authority.acquire(writeLease(link))).rejects.toThrow(code('E_ACL_ROOT_NOT_CANONICAL'))
    await expect(authority.acquire(writeLease(realpathSync(link)))).rejects.toThrow(
      code('E_ACL_ROOT_OVERLAP'),
    )
    expect(world.ntfs.calls.apply).toBe(0)
  })

  it('refuses a root around existing lease temps, from the same and from a cold authority', async () => {
    const host = aclHost(world)
    await host.authority.acquire(writeLease(world.workspace))
    const outer = join(base, 'outer')
    const parent = dirname(world.tempRoot)
    world.ntfs.directory(outer)
    for (const authority of [host.authority, aclHost(world, { pid: 303 }).authority]) {
      await expect(authority.acquire(writeLease(parent))).rejects.toThrow(code('E_ACL_ROOT_OVERLAP'))
      await expect(authority.acquire(writeLease(outer))).resolves.toBeDefined()
    }
  })

  it('refuses new temps inside a workspace granted earlier, also after a cold start', async () => {
    await aclHost(world).authority.acquire(writeLease(world.workspace))
    const applied = world.ntfs.calls.apply
    const other = join(base, 'other')
    world.ntfs.directory(other)
    for (const options of [
      { tempRoot: join(world.workspace, 'tmp') },
      { privateRoots: [join(world.workspace, 'home')] },
    ]) {
      const cold = aclHost(world, { pid: 404, ...options })
      await expect(cold.authority.acquire(writeLease(other))).rejects.toThrow(code('E_ACL_ROOT_OVERLAP'))
    }
    expect(world.ntfs.calls.apply).toBe(applied)
    expect(existsSync(join(world.workspace, 'tmp'))).toBe(false)
  })
})

describe('roots that contain code the Host runs unconfined', () => {
  it('refuses a workspace that contains a runtime directory, but not one inside it', async () => {
    const runtime = join(base, 'install', 'node_modules', '@agnes', 'system-node', 'runtime')
    mkdirSync(runtime, { recursive: true })
    const { authority } = aclHost(world, { runtimeRoots: [runtime] })
    for (const root of [join(base, 'install'), runtime]) {
      world.ntfs.directory(root)
      await expect(authority.acquire(writeLease(root))).rejects.toThrow(code('E_ACL_ROOT_OVERLAP'))
    }
    // A workspace inside a runtime directory cannot reach the code above it.
    const inside = join(runtime, 'scratch')
    world.ntfs.directory(inside)
    await expect(authority.acquire(writeLease(inside))).resolves.toBeDefined()
    // A runtime directory that does not exist yet is judged by where it will be.
    const later = aclHost(world, { pid: 505, runtimeRoots: [join(world.workspace, 'node', 'bin')] })
    await expect(later.authority.acquire(writeLease(world.workspace))).rejects.toThrow(
      code('E_ACL_ROOT_OVERLAP'),
    )
    // Only the workspace inside the runtime directory was granted (with its lease temp).
    expect(world.ntfs.calls.apply).toBe(2)
  })

  it('refuses new leases while a granted workspace contains a runtime directory, also after a cold start', async () => {
    await aclHost(world).authority.acquire(writeLease(world.workspace))
    const applied = world.ntfs.calls.apply
    const other = join(base, 'other')
    world.ntfs.directory(other)
    const cold = aclHost(world, { pid: 606, runtimeRoots: [join(world.workspace, 'checkout', 'runtime')] })
    await expect(cold.authority.acquire(writeLease(other))).rejects.toThrow(code('E_ACL_ROOT_OVERLAP'))
    expect(world.ntfs.calls.apply).toBe(applied)
  })
})

describe('launch permits', () => {
  it('re-checks the root, the record and the grant generation before each permit', async () => {
    const a = aclHost(world, { pid: 101 })
    const launcher = new Launcher()
    const lease = await a.authority.acquire(writeLease(world.workspace))
    await launcher.launch(lease)
    world.ntfs.thirdPartyChange(world.workspace)
    // Another Host notices the change and records it; this lease's next launch sees the new generation.
    await expect(aclHost(world, { pid: 202 }).authority.acquire(writeLease(world.workspace))).rejects.toThrow(
      code('E_ACL_CHANGED'),
    )
    await expect(lease.prepareLaunch()).rejects.toThrow(code('E_ACL_GRANT_CHANGED'))
    world.ntfs.replace(world.workspace)
    await expect(lease.prepareLaunch()).rejects.toThrow(code('E_ACL_IDENTITY_MISMATCH'))
    expect(launcher.count).toBe(1)
  })

  it('cannot be forged, copied or used twice', async () => {
    const { authority } = aclHost(world)
    const lease = await authority.acquire(writeLease(world.workspace))
    const permit = await lease.prepareLaunch()
    const forged = [
      JSON.parse(JSON.stringify(permit)),
      structuredClone(permit),
      { ...permit },
      { leaseId: lease.id },
    ] as WindowsAclLaunchPermit[]
    for (const fake of forged)
      expect(() => claimWindowsLaunchPermit(fake)).toThrow(code('E_ACL_PERMIT_INVALID'))
    const claim = claimWindowsLaunchPermit(permit)
    expect(() => claimWindowsLaunchPermit(permit)).toThrow(code('E_ACL_PERMIT_INVALID'))
    claim.abandoned()
    expect(() => claim.abandoned()).toThrow(code('E_ACL_PERMIT_USED'))
    await lease.close()
  })
})

describe('closing leases', () => {
  it('waits for its processes, then revokes and removes the temp; the workspace grant stays', async () => {
    const { authority } = aclHost(world)
    const lease = await authority.acquire(writeLease(world.workspace))
    const exit = deferred()
    claimWindowsLaunchPermit(await lease.prepareLaunch()).started(exit.promise)
    let closed = false
    const closing = lease.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(closed).toBe(false)
    expect(existsSync(lease.tempRoot ?? '')).toBe(true)
    await expect(lease.prepareLaunch()).rejects.toThrow(code('E_ACL_LEASE_CLOSED'))
    exit.resolve()
    await closing
    expect(existsSync(lease.tempRoot ?? '')).toBe(false)
    expect(grants('temp').map((record) => record.state)).toEqual(['revoked'])
    expect(grants('workspace').map((record) => record.state)).toEqual(['active'])
    expect(world.ntfs.sddl(world.workspace)).toContain('S-1-4-')
    expect(await authority.inspect(world.workspace)).toMatchObject({ state: 'active' })
  })

  it('keeps everything while a permit is unsettled or an exit is unproven', async () => {
    const { authority } = aclHost(world)
    const lease = await authority.acquire(writeLease(world.workspace))
    const pending = await lease.prepareLaunch()
    await expect(lease.close()).rejects.toThrow(code('E_ACL_LEASE_BUSY'))
    expect(existsSync(lease.tempRoot ?? '')).toBe(true)
    expect(() => claimWindowsLaunchPermit(pending)).toThrow(code('E_ACL_LEASE_CLOSED'))
    await lease.close()
    expect(existsSync(lease.tempRoot ?? '')).toBe(false)

    const other = await authority.acquire(writeLease(world.workspace, 'session-b'))
    const exit = deferred()
    claimWindowsLaunchPermit(await other.prepareLaunch()).started(exit.promise)
    exit.reject(new Error('wait failed'))
    await expect(other.close()).rejects.toThrow(code('E_ACL_PROCESS_UNSETTLED'))
    await expect(other.close()).rejects.toThrow(code('E_ACL_PROCESS_UNSETTLED'))
    expect(existsSync(other.tempRoot ?? '')).toBe(true)
    expect(grants('temp').filter((record) => record.state === 'active')).toHaveLength(1)
  })

  it('a failed cleanup can be retried and loses no record', async () => {
    const host = aclHost(world)
    const lease = await host.authority.acquire(writeLease(world.workspace))
    const remove = host.platform.removeDirectory
    let failures = 1
    Object.assign(host.platform, {
      removeDirectory: async (path: string) => {
        if (failures-- > 0) throw Object.assign(new Error('in use'), { code: 'EBUSY' })
        return remove(path)
      },
    })
    await expect(lease.close()).rejects.toThrow(code('EBUSY'))
    expect(existsSync(lease.tempRoot ?? '')).toBe(true)
    expect(existsSync(join(world.stateRoot, 'leases', lease.id))).toBe(true)
    await lease.close()
    expect(existsSync(lease.tempRoot ?? '')).toBe(false)
    expect(existsSync(join(world.stateRoot, 'leases', lease.id))).toBe(false)
  })

  it('dispose closes every lease after its processes and refuses new leases', async () => {
    const { authority } = aclHost(world)
    const a = await authority.acquire(writeLease(world.workspace, 'session-a'))
    const b = await authority.acquire(writeLease(world.workspace, 'session-b'))
    const exit = deferred()
    claimWindowsLaunchPermit(await a.prepareLaunch()).started(exit.promise)
    const disposing = authority.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(existsSync(a.tempRoot ?? '')).toBe(true)
    exit.resolve()
    await disposing
    expect([a.tempRoot, b.tempRoot].some((path) => existsSync(path ?? ''))).toBe(false)
    await expect(authority.acquire(writeLease(world.workspace))).rejects.toThrow(code('E_ACL_DISPOSED'))
    expect(grants('workspace').map((record) => record.state)).toEqual(['active'])
  })

  it('after a Host crash, new leases get a new temp and SID; the old temp goes only once its Host is proven gone', async () => {
    const crashed = aclHost(world, { pid: 101 })
    const old = await crashed.authority.acquire(writeLease(world.workspace))
    const oldClaim = await new Launcher().launch(old)
    const next = aclHost(world, { pid: 202 })
    next.platform.processes.set(101, { state: 'unknown', reason: 'no access' })
    const fresh = await next.authority.acquire(writeLease(world.workspace))
    const freshClaim = await new Launcher().launch(fresh)
    expect(fresh.tempRoot).not.toBe(old.tempRoot)
    expect(freshClaim.writeSids[1]).not.toBe(oldClaim.writeSids[1])
    expect(existsSync(old.tempRoot ?? '')).toBe(true)
    next.platform.processes.set(101, { state: 'alive', startId: 'a-later-process' })
    await next.authority.acquire(writeLease(world.workspace, 'session-c'))
    expect(existsSync(old.tempRoot ?? '')).toBe(false)
    expect(existsSync(join(world.stateRoot, 'leases', old.id))).toBe(false)
    expect(existsSync(fresh.tempRoot ?? '')).toBe(true)
  })
})
