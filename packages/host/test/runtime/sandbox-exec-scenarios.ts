import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createPlatform } from '../../src/adapters/platform.js'
import { cleanup, error, type Kind } from './network-secrets-fixture.js'
import { fixture } from './sandbox-exec-fixture.js'

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export async function until(check: () => boolean | Promise<boolean>, milliseconds = 7000) {
  const expiry = Date.now() + milliseconds
  while (!(await check())) {
    if (Date.now() >= expiry) throw new Error('Process observation timed out')
    await pause(20)
  }
}
export function alive(pid: number) {
  try {
    const status = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return status !== '' && !status.startsWith('Z')
  } catch {
    return false
  }
}
export function pids(file: string) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}

/** Refusal, pre-admission cancellation and disposal only; never normal/recovery evidence. */
export async function scenario(kind: Kind, service: 'sandbox' | 'exec', name: string) {
  assert.ok(['deny', 'cancel', 'dispose'].includes(name), 'No qualified launch backend')
  const f = await fixture(kind)
  try {
    let context = f.auth.call()
    if (name === 'cancel') {
      const abort = new AbortController()
      abort.abort()
      context = f.auth.call({ signal: abort.signal })
    }
    if (name === 'dispose') await f[service].close()
    const request = {
      sandboxRef: {
        authorityId: 'sandbox-authority',
        sandboxId: 'not-admitted',
        ownerBinding: f.sandbox.binding,
        lease: f.mount.lease,
      },
      argv: ['/bin/echo'],
      cwd: { mount: f.mount, path: '' },
      env: [],
      stdinRef: null,
      limits: f.createInput.resourceLimits,
    }
    const response =
      service === 'sandbox'
        ? await f.sandbox.create(f.createInput, context)
        : await f.exec.run(request, context)
    if (name === 'deny') {
      assert.equal(response.ok, false)
      assert.equal(error(response), expectedRefusal(service))
      assert.equal(f[service].features.length, 0)
      const forged = { ...f.auth.call() }
      const denied =
        service === 'sandbox'
          ? await f.sandbox.create(f.createInput, forged)
          : await f.exec.run(request, forged)
      assert.equal(error(denied), `denied/${service}_denied`)
    } else
      assert.equal(
        error(response),
        name === 'cancel' ? `cancelled/${service}_cancelled` : `denied/${service}_closed`,
      )
  } finally {
    await f.close()
    cleanup(f.directory)
  }
}
export function expectedRefusal(service: 'sandbox' | 'exec') {
  const { os } = createPlatform()
  if (os === 'darwin') return `incompatible/${service}_limit_memoryBytes_unsupported`
  if (service === 'sandbox') return 'incompatible/sandbox_isolation_unsupported'
  return os === 'win32'
    ? 'incompatible/exec_limit_openFiles_unsupported'
    : 'incompatible/exec_platform_unsupported'
}
