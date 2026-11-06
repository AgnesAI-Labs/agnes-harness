// The worker thread that runs the tree-walking Windows ACL primitives off the Host's event loop.
// The worker is real; the native module it loads is a fake that spins, hangs, refuses or dies on
// request, so the main thread's responsiveness and every failure path can be observed on any OS.
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

type WorkerModule = typeof import('../src/windows-acl-worker.js')

const scratch = mkdtempSync(join(tmpdir(), 'agnes-acl-worker-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const fakeNative = join(scratch, 'native.cjs')
const testBuild = join(scratch, 'test-build.cjs')
// Paths name the behaviour: spin:<ms>, refuse, malformed, die; anything else answers at once.
writeFileSync(
  fakeNative,
  `const { createHash } = require('node:crypto')
const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} }
const print = (sddl) => createHash('sha256')
  .update(Buffer.from('agnes-windows-acl-v1\\n0000000000000001\\n' + '0'.repeat(31) + '2\\n' + sddl, 'utf16le'))
  .digest('hex')
module.exports = {
  abiVersion: 1,
  aclInspect(path) {
    const name = path.slice(path.lastIndexOf('\\\\') + 1)
    if (name.startsWith('spin-')) spin(Number(name.slice(5)))
    if (name === 'refuse')
      throw Object.assign(new Error('E_ACL_BROAD_WRITE: broad'), { code: 'E_ACL_BROAD_WRITE', path: 'C:\\\\w\\\\refuse', win32Code: 0 })
    if (name === 'invalid') throw Object.assign(new TypeError('bad argument'), { code: 'EINVAL' })
    if (name === 'malformed') return { path }
    if (name === 'die') process.exit(3)
    return { path: path.slice(4), volumeId: '0000000000000001', fileId: '0'.repeat(31) + '2', securityDescriptor: 'D:AI',
      fingerprint: print('D:AI'), ownedFingerprint: 'e'.repeat(64), descendants: [], inheritedDescendants: 0 }
  },
  aclApply: (...args) => ({ complete: true, changes: [], failures: [], inheritedDescendants: args.length, ownedFingerprint: 'f'.repeat(64) }),
  aclRestore: () => ({ complete: false, changes: [], failures: [], inheritedDescendants: 0 }),
  aclIdentity: () => ({}),
}
`,
)
writeFileSync(testBuild, `module.exports = { ...require(${JSON.stringify(fakeNative)}), testFaults: true }\n`)

const fake = vi.hoisted(() => ({ native: '', loads: 0 }))
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (url: string) => {
      const real = actual.createRequire(url)
      const require = Object.assign((id: string) => {
        if (id !== '@agnes/system-node/native') return real(id)
        fake.loads++
        // The main thread checks the same artifact before it starts a worker; the package loader
        // also wants every other Windows primitive, which this fake answers with no-ops.
        const binding = { ...real(fake.native), testFaults: undefined }
        return new Proxy(binding, {
          get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}),
        })
      }, real)
      require.resolve = Object.assign(
        (id: string, options?: never) =>
          id === '@agnes/system-node/native' ? fake.native : real.resolve(id, options),
        real.resolve,
      )
      return require
    },
  }
})

const original = Object.getOwnPropertyDescriptor(process, 'platform')
async function load(platform: NodeJS.Platform): Promise<WorkerModule> {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try {
    return await import('../src/windows-acl-worker.js')
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

const open: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const worker of open.splice(0)) await worker.close()
  fake.native = fakeNative
  fake.loads = 0
})
fake.native = fakeNative

async function worker(options?: { timeoutMs?: number }) {
  const module = await load('win32')
  const client = module.createWindowsAclWorker(options)
  open.push(client)
  return client
}
const code = (expected: string) => expect.objectContaining({ code: expected })
const print = createHash('sha256')
  .update(Buffer.from(`agnes-windows-acl-v1\n0000000000000001\n${'0'.repeat(31)}2\nD:AI`, 'utf16le'))
  .digest('hex')

describe('Windows ACL worker', () => {
  it('runs a walk on another thread while the event loop keeps running', async () => {
    const acl = await worker()
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    const started = Date.now()
    const snapshot = await acl.inspect('C:\\work\\spin-600')
    clearInterval(timer)
    expect(Date.now() - started).toBeGreaterThanOrEqual(550)
    // A walk on this thread would have let no timer run until it returned.
    expect(ticks).toBeGreaterThanOrEqual(15)
    expect(snapshot).toEqual({
      path: 'C:\\work\\spin-600',
      identity: { volumeId: '0000000000000001', fileId: `${'0'.repeat(31)}2` },
      securityDescriptor: 'D:AI',
      fingerprint: print,
      ownedFingerprint: 'e'.repeat(64),
      descendants: [],
      inheritedDescendants: 0,
    })
  })

  it('validates requests before they reach the worker and results after', async () => {
    const acl = await worker()
    await expect(acl.inspect('relative\\path')).rejects.toThrow(code('EINVAL'))
    await expect(acl.apply({ before: {}, grantId: 'g', writeSid: 'S-1-1-0' } as never)).rejects.toThrow(
      code('EINVAL'),
    )
    await expect(acl.inspect('C:\\work\\malformed')).rejects.toThrow(code('E_SYSTEM_NATIVE_UNAVAILABLE'))
    const before = await acl.inspect('C:\\work\\root')
    const grant = await acl.apply({ before, grantId: 'grant-1', writeSid: 'S-1-4-1-2' })
    expect(grant).toMatchObject({ grantId: 'grant-1', complete: true, inheritedDescendants: 6 })
    expect(grant.ownedFingerprint).toBe('f'.repeat(64))
    const restore = await acl.restore({
      before,
      grantId: 'grant-1',
      expectedCurrentFingerprint: before.fingerprint,
      removableChanges: [{ kind: 'allow', sid: 'S-1-4-1-2', mask: 0x110156, flags: 3 }],
    })
    expect(restore.complete).toBe(false)
  })

  it('passes native refusals through with their code, path and Win32 code', async () => {
    const acl = await worker()
    await expect(acl.inspect('C:\\w\\refuse')).rejects.toMatchObject({
      code: 'E_ACL_BROAD_WRITE',
      path: 'C:\\w\\refuse',
      message: 'E_ACL_BROAD_WRITE: broad',
    })
    const invalid = await acl.inspect('C:\\w\\invalid').catch((error: unknown) => error)
    expect(invalid).toBeInstanceOf(TypeError)
    expect(invalid).toMatchObject({ code: 'EINVAL' })
  })

  it('fails a hung call closed at its deadline and serves the next call from a fresh worker', async () => {
    const acl = await worker({ timeoutMs: 200 })
    const started = Date.now()
    await expect(acl.inspect('C:\\work\\spin-3000')).rejects.toThrow(code('E_ACL_WORKER_TIMEOUT'))
    expect(Date.now() - started).toBeLessThan(1500)
    await expect(acl.inspect('C:\\work\\root')).resolves.toMatchObject({ fingerprint: print })
  })

  it('fails a call whose worker dies, and serves the next call from a fresh worker', async () => {
    const acl = await worker()
    await expect(acl.inspect('C:\\work\\die')).rejects.toThrow(code('E_ACL_WORKER_FAILED'))
    await expect(acl.inspect('C:\\work\\root')).resolves.toMatchObject({ fingerprint: print })
  })

  it('runs one call at a time, in order', async () => {
    const acl = await worker()
    const order: string[] = []
    await Promise.all([
      acl.inspect('C:\\work\\spin-200').then(() => order.push('slow')),
      acl.inspect('C:\\work\\root').then(() => order.push('fast')),
    ])
    expect(order).toEqual(['slow', 'fast'])
  })

  it('refuses a test build of the native artifact inside the worker', async () => {
    fake.native = testBuild
    const acl = await worker()
    await expect(acl.inspect('C:\\work\\root')).rejects.toThrow(code('E_SYSTEM_NATIVE_UNAVAILABLE'))
  })

  it('refuses after close', async () => {
    const acl = await worker()
    await acl.close()
    await expect(acl.inspect('C:\\work\\root')).rejects.toThrow(code('E_ACL_WORKER_CLOSED'))
  })

  it.each(['darwin', 'linux'] as const)('reports ENOSYS on %s without starting a worker', async (os) => {
    const module = await load(os)
    const acl = module.createWindowsAclWorker()
    open.push(acl)
    await expect(acl.inspect('C:\\work\\root')).rejects.toThrow(code('ENOSYS'))
    expect(fake.loads).toBe(0)
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses the timeout %s', async (timeoutMs) => {
    const module = await load('win32')
    expect(() => module.createWindowsAclWorker({ timeoutMs })).toThrow(code('EINVAL'))
  })
})
