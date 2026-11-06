// Grant journal and recovery of the Windows execution authority, against modelled NTFS permissions
// and a real journal directory. A "crash" is an error thrown at the chosen point together with every
// later journal write failing, which is what a process that died there leaves on disk.
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WindowsAclJournal } from '../src/windows-acl/journal.js'
import {
  type AclWorld,
  aclHost,
  aclWorld,
  Launcher,
  leaveLock,
  recordsOnDisk,
  writeLease,
} from './fixtures/windows-acl-fakes.js'

let base = ''
let world: AclWorld
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'agh-acl-journal-')))
  world = aclWorld(base)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const code = (expected: string) => expect.objectContaining({ code: expected })
const workspaceRecords = () => recordsOnDisk(world.stateRoot).filter((record) => record.kind === 'workspace')
const crash = () => Object.assign(new Error('simulated process death'), { code: 'E_TEST_CRASH' })

describe('grant journal ordering', () => {
  it('never mutates ACLs before the recovery record is durable', async () => {
    const { authority, files } = aclHost(world)
    files.failFrom = 1
    await expect(authority.acquire(writeLease(world.workspace))).rejects.toThrow()
    expect(world.ntfs.calls.apply).toBe(0)
  })

  it('records the complete pre-grant snapshot before the native change', async () => {
    const { authority } = aclHost(world)
    const seen: unknown[] = []
    world.ntfs.beforeApply = (input) => {
      const prepared = recordsOnDisk(world.stateRoot).find((record) => record.grantId === input.grantId)
      seen.push(prepared?.state)
      expect(prepared?.before).toEqual(input.before)
      expect(prepared?.writeSid).toBe(input.writeSid)
    }
    await authority.acquire(writeLease(world.workspace))
    expect(seen).toEqual(['prepared', 'prepared'])
  })

  it('refuses when the state root is not private, before any change', async () => {
    const { authority } = aclHost(world)
    await authority.inspect(world.workspace)
    chmodSync(world.stateRoot, 0o755)
    await expect(authority.acquire(writeLease(world.workspace))).rejects.toThrow(code('E_ACL_STATE_UNSAFE'))
    expect(world.ntfs.calls.apply).toBe(0)
  })
})

describe('recovery after an interrupted grant', () => {
  const original = () => world.ntfs.sddl(world.workspace)

  /** Host A dies at the chosen point; Host B starts cold with A's lock still on disk. */
  async function crashThenRecover(arm: (host: ReturnType<typeof aclHost>) => void) {
    const before = original()
    const a = aclHost(world, { pid: 101 })
    arm(a)
    await expect(a.authority.acquire(writeLease(world.workspace))).rejects.toThrow()
    leaveLock(world.stateRoot, 101)
    delete world.ntfs.beforeApply
    world.ntfs.applyOutcome = 'complete'
    const b = aclHost(world, { pid: 202 })
    const launcher = new Launcher()
    await expect(
      b.authority.acquire(writeLease(world.workspace)).then((lease) => launcher.launch(lease)),
    ).rejects.toThrow(code('E_ACL_NEEDS_ATTENTION'))
    expect(launcher.count).toBe(0)
    expect(workspaceRecords().map((record) => record.state)).toEqual(['needs-attention'])
    const report = await b.authority.inspect(world.workspace)
    expect(report).toMatchObject({ state: 'needs-attention', repairable: true })
    return { before, b, report }
  }
  const dieAt = (host: ReturnType<typeof aclHost>) => {
    host.files.failFrom = host.files.writes + 1
    return crash()
  }

  it('after the prepared record, before any change: repair finds nothing applied', async () => {
    const { before, b, report } = await crashThenRecover((a) => {
      world.ntfs.beforeApply = () => {
        throw dieAt(a)
      }
    })
    const repaired = await b.authority.repair({
      root: world.workspace,
      grantId: report.grantId ?? '',
      expectedRecordDigest: report.recordDigest ?? '',
    })
    expect(repaired.state).toBe('revoked')
    expect(original()).toBe(before)
    expect(world.ntfs.calls.restore).toBe(0)
  })

  it('in the middle of the change: repair removes the grant SID and proves the original state', async () => {
    const { before, b, report } = await crashThenRecover((a) => {
      world.ntfs.applyOutcome = 'crash-after-allow'
      world.ntfs.beforeApply = () => void dieAt(a)
    })
    expect(original()).not.toBe(before)
    const repaired = await b.authority.repair({
      root: world.workspace,
      grantId: report.grantId ?? '',
      expectedRecordDigest: report.recordDigest ?? '',
    })
    expect(repaired.state).toBe('revoked')
    expect(original()).toBe(before)
  })

  it('after the change but before its result was recorded: unproven entries need attention', async () => {
    const { before, b, report } = await crashThenRecover((a) => {
      world.ntfs.applyOutcome = 'crash-after-write'
      world.ntfs.beforeApply = () => void dieAt(a)
    })
    const repaired = await b.authority.repair({
      root: world.workspace,
      grantId: report.grantId ?? '',
      expectedRecordDigest: report.recordDigest ?? '',
    })
    expect(repaired.state).toBe('needs-attention')
    expect(repaired.issues.map((issue) => issue.reason)).toContainEqual(expect.stringMatching(/^unproven/))
    expect(repaired.steps.join('\n')).toMatch(/Low integrity label/)
    // The grant SID itself is gone; only entries that may have been there before are left.
    const sid = recordsOnDisk(world.stateRoot)[0]?.writeSid ?? ''
    expect(original()).not.toContain(sid)
    const object = world.ntfs.objects.get(world.workspace)
    if (!object) throw new Error('workspace not modelled')
    object.dacl = object.dacl.filter((ace) => !ace.startsWith('(D;'))
    object.label = []
    expect(original()).toBe(before)
    const again = await b.authority.inspect(world.workspace)
    const finished = await b.authority.repair({
      root: world.workspace,
      grantId: again.grantId ?? '',
      expectedRecordDigest: again.recordDigest ?? '',
    })
    expect(finished.state).toBe('revoked')
  })

  it('after the result was recorded but before it was verified: repair removes exactly what was added', async () => {
    const { before, b, report } = await crashThenRecover((a) => {
      a.files.failWhen = (_path, text) => {
        if (!text.includes('"state":"active"')) return false
        a.files.failFrom = a.files.writes
        return true
      }
      delete world.ntfs.beforeApply
    })
    expect(report.issues.map((issue) => issue.reason)).toContainEqual(expect.stringMatching(/^interrupted/))
    const repaired = await b.authority.repair({
      root: world.workspace,
      grantId: report.grantId ?? '',
      expectedRecordDigest: report.recordDigest ?? '',
    })
    expect(repaired.state).toBe('revoked')
    expect(original()).toBe(before)
  })

  it('a crash while restoring never reads as active or revoked', async () => {
    const before = original()
    const a = aclHost(world, { pid: 101 })
    const lease = await a.authority.acquire(writeLease(world.workspace))
    await lease.close()
    const report = await a.authority.inspect(world.workspace)
    world.ntfs.restoreOutcome = 'crash-after-write'
    a.files.failFrom = a.files.writes + 2
    await expect(
      a.authority.repair({
        root: world.workspace,
        grantId: report.grantId ?? '',
        expectedRecordDigest: report.recordDigest ?? '',
      }),
    ).rejects.toThrow()
    leaveLock(world.stateRoot, 101)
    world.ntfs.restoreOutcome = 'complete'
    const b = aclHost(world, { pid: 202 })
    const cold = await b.authority.inspect(world.workspace)
    expect(cold.state).toBe('needs-attention')
    await expect(b.authority.acquire(writeLease(world.workspace))).rejects.toThrow(
      code('E_ACL_NEEDS_ATTENTION'),
    )
    const repaired = await b.authority.repair({
      root: world.workspace,
      grantId: cold.grantId ?? '',
      expectedRecordDigest: cold.recordDigest ?? '',
    })
    expect(repaired.state).toBe('revoked')
    expect(original()).toBe(before)
  })

  it('an incomplete grant launches nothing and is undone when that is provably safe', async () => {
    const before = original()
    const { authority } = aclHost(world)
    world.ntfs.applyOutcome = 'incomplete'
    await expect(authority.acquire(writeLease(world.workspace))).rejects.toThrow(
      code('E_ACL_GRANT_INCOMPLETE'),
    )
    expect(workspaceRecords().map((record) => record.state)).toEqual(['revoked'])
    expect(original()).toBe(before)
  })

  it('a native refusal before any change revokes the record and keeps the permissions', async () => {
    const before = original()
    const { authority } = aclHost(world)
    world.ntfs.beforeApply = () => {
      throw Object.assign(new Error('busy'), { code: 'E_ACL_BUSY' })
    }
    await expect(authority.acquire(writeLease(world.workspace))).rejects.toThrow(code('E_ACL_BUSY'))
    expect(workspaceRecords()).toMatchObject([{ state: 'revoked', issues: [{ code: 'E_ACL_BUSY' }] }])
    expect(original()).toBe(before)
  })
})

describe('damaged records and the cross-process lock', () => {
  it('refuses on a damaged record and keeps it as found', async () => {
    const { authority } = aclHost(world)
    await (await authority.acquire(writeLease(world.workspace))).close()
    const grantId = workspaceRecords()[0]?.grantId ?? ''
    const file = join(world.stateRoot, 'grants', grantId)
    const damaged = `${readFileSync(file, 'utf8').slice(0, -10)}garbage`
    writeFileSync(file, damaged)
    const applied = world.ntfs.calls.apply
    const fresh = aclHost(world, { pid: 303 })
    await expect(fresh.authority.acquire(writeLease(world.workspace))).rejects.toThrow(
      code('E_ACL_JOURNAL_CORRUPT'),
    )
    expect(world.ntfs.calls.apply).toBe(applied)
    const report = await fresh.authority.inspect(world.workspace)
    expect(report).toMatchObject({ state: 'needs-attention', repairable: false })
    expect(report.steps.join('\n')).toMatch(/damaged/)
    const restores = world.ntfs.calls.restore
    const repaired = await fresh.authority.repair({
      root: world.workspace,
      grantId,
      expectedRecordDigest: 'x',
    })
    expect(repaired).toMatchObject({ state: 'needs-attention', repairable: false })
    expect(world.ntfs.calls.restore).toBe(restores)
    expect(readFileSync(file, 'utf8')).toBe(damaged)
  })

  it('waits for a live holder, then reports busy without changing anything', async () => {
    const { authority, platform } = aclHost(world)
    platform.processes.set(555, { state: 'alive', startId: 'dead:555' })
    leaveLock(world.stateRoot, 555)
    await expect(authority.acquire(writeLease(world.workspace))).rejects.toThrow(code('E_ACL_BUSY'))
    platform.processes.set(555, { state: 'unknown', reason: 'no access' })
    await expect(authority.acquire(writeLease(world.workspace))).rejects.toThrow(code('E_ACL_BUSY'))
    expect(world.ntfs.calls.apply).toBe(0)
  })

  it('takes over the lock of a Host whose process ID now belongs to another process', async () => {
    const { authority, platform } = aclHost(world)
    platform.processes.set(555, { state: 'alive', startId: 'another-process' })
    leaveLock(world.stateRoot, 555)
    await expect(authority.acquire(writeLease(world.workspace))).resolves.toBeDefined()
  })
})

describe('third-party changes and repair rules', () => {
  const repairWith = async (host: ReturnType<typeof aclHost>, digest?: string) => {
    const report = await host.authority.inspect(world.workspace)
    return host.authority.repair({
      root: world.workspace,
      grantId: report.grantId ?? '',
      expectedRecordDigest: digest ?? report.recordDigest ?? '',
    })
  }

  it('never overwrites a third-party change and launches nothing once it is seen', async () => {
    const host = aclHost(world)
    const launcher = new Launcher()
    const first = await host.authority.acquire(writeLease(world.workspace))
    world.ntfs.thirdPartyChange(world.workspace)
    const afterChange = new Launcher()
    await expect(
      host.authority
        .acquire(writeLease(world.workspace, 'session-b'))
        .then((lease) => afterChange.launch(lease)),
    ).rejects.toThrow(code('E_ACL_CHANGED'))
    await expect(launcher.launch(first)).rejects.toThrow(code('E_ACL_GRANT_CHANGED'))
    expect(afterChange.count + launcher.count).toBe(0)
    await first.close()
    const repaired = await repairWith(host)
    expect(repaired.state).toBe('revoked')
    expect(repaired.issues.map((issue) => issue.reason)).toContainEqual(expect.stringMatching(/^changed/))
    expect(world.ntfs.sddl(world.workspace)).toContain('S-1-5-21-1-2-3-1001')
    expect(world.ntfs.sddl(world.workspace)).not.toContain('S-1-4-')
  })

  it('requires the digest of the record it inspected', async () => {
    const host = aclHost(world)
    await (await host.authority.acquire(writeLease(world.workspace))).close()
    const restores = world.ntfs.calls.restore
    const refused = await repairWith(host, '0'.repeat(64))
    expect(refused).toMatchObject({ state: 'active', repairable: false })
    expect(refused.issues[0]?.reason).toMatch(/^record-changed/)
    expect(world.ntfs.calls.restore).toBe(restores)
  })

  it('refuses while a lease of this or another Host uses the grant, or its usage is unknown', async () => {
    const a = aclHost(world, { pid: 101 })
    const b = aclHost(world, { pid: 202 })
    const own = await a.authority.acquire(writeLease(world.workspace))
    expect((await repairWith(a)).issues[0]?.reason).toMatch(/^in-use/)
    await own.close()
    await b.authority.acquire(writeLease(world.workspace, 'session-b'))
    const restores = world.ntfs.calls.restore
    a.platform.processes.set(202, { state: 'alive', startId: b.platform.self.startId })
    expect((await repairWith(a)).issues[0]?.reason).toMatch(/^in-use/)
    a.platform.processes.set(202, { state: 'unknown', reason: 'no access' })
    const unknown = await repairWith(a)
    expect(unknown).toMatchObject({ state: 'active', repairable: false })
    expect(unknown.issues[0]?.reason).toMatch(/^usage-unknown/)
    expect(world.ntfs.calls.restore).toBe(restores)
    a.platform.processes.delete(202)
    expect((await repairWith(a)).state).toBe('revoked')
  })

  it('removes only the entries this grant added', async () => {
    const object = world.ntfs.objects.get(world.workspace)
    object?.dacl.unshift('(D;CI;DC;;;WD)')
    const before = world.ntfs.sddl(world.workspace)
    const host = aclHost(world)
    await (await host.authority.acquire(writeLease(world.workspace))).close()
    expect((await repairWith(host)).state).toBe('revoked')
    expect(world.ntfs.sddl(world.workspace)).toBe(before)
  })

  it('keeps the deny and Low label another grant on the same object still needs', async () => {
    const host = aclHost(world)
    await (await host.authority.acquire(writeLease(world.workspace))).close()
    const [first] = workspaceRecords()
    if (!first) throw new Error('no grant')
    // A second recorded grant on the same directory, as an older Host could have left it.
    const journal = new WindowsAclJournal({
      root: world.stateRoot,
      files: host.files,
      ensurePrivateDirectory: (path) => host.platform.ensurePrivateDirectory(path),
      self: host.platform.self,
      processIdentity: (pid) => host.platform.processIdentity(pid),
      lockWaitMs: 150,
    })
    await journal.open()
    const before = world.ntfs.inspect(world.workspace)
    const writeSid = 'S-1-4-7-7-7-7'
    const mutation = world.ntfs.apply({ before, grantId: 'second', writeSid })
    const change = mutation.changes[0]
    if (!change) throw new Error('no change')
    journal.write({
      grantId: 'second',
      kind: 'workspace',
      root: world.workspace,
      rootIdentity: before.identity,
      writeSid,
      state: 'active',
      before,
      applied: { fingerprint: change.afterFingerprint, added: change.added },
      issues: [],
    })
    const repaired = await host.authority.repair({
      root: world.workspace,
      grantId: first.grantId,
      expectedRecordDigest: journal.grant(first.grantId)?.digest ?? '',
    })
    expect(repaired.state).toBe('revoked')
    expect(repaired.issues.map((issue) => issue.reason)).toContainEqual(expect.stringMatching(/^shared/))
    const sddl = world.ntfs.sddl(world.workspace)
    expect(sddl).not.toContain(first.writeSid)
    expect(sddl).toContain('(D;CI;DC;;;WD)')
    expect(sddl).toContain('(ML;OICI;NW;;;LW)')
    // The remaining grant still reads as AGH left it and keeps working.
    const launcher = new Launcher()
    const claim = await launcher.launch(await host.authority.acquire(writeLease(world.workspace)))
    expect(claim.writeSids[0]).toBe(writeSid)
  })
})
