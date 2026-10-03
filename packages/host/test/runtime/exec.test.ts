import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanup, error, must, resolveInput, scan, secrets } from './network-secrets-fixture.js'
import { fixture } from './sandbox-exec-fixture.js'

describe.each(['default', 'reference'] as const)('%s execution admission', (kind) => {
  it('requires current authentic calls and never launches malformed input', async () => {
    const f = await fixture(kind)
    try {
      expect(error(await f.exec.run({}, { ...f.auth.call() }))).toBe('denied/exec_denied')
      expect(error(await f.exec.run({}, f.auth.call()))).toBe('invalid_input/exec_schema')
      const abort = new AbortController()
      abort.abort()
      expect(error(await f.exec.run({}, f.auth.call({ signal: abort.signal })))).toBe(
        'cancelled/exec_cancelled',
      )
      await f.exec.close()
      expect(error(await f.exec.run({}, f.auth.call()))).toBe('denied/exec_closed')
    } finally {
      await f.close()
      cleanup(f.directory)
    }
  })
  it('rejects a frozen handle from the selected broker without material disclosure', async () => {
    const f = await fixture(kind),
      broker = secrets(kind, join(f.directory, 'broker'), f.auth)
    try {
      const handle = must(await broker.resolve(resolveInput, f.auth.call()))
      const sandboxRef = {
        authorityId: 'sandbox-authority',
        sandboxId: 'unsupported',
        ownerBinding: f.sandbox.binding,
        lease: f.mount.lease,
      }
      const output = await f.exec.run(
        {
          sandboxRef,
          argv: ['/bin/echo'],
          cwd: { mount: f.mount, path: '' },
          env: [{ name: 'FIXTURE_VALUE', value: { kind: 'secret', handle } }],
          stdinRef: null,
          limits: f.createInput.resourceLimits,
        },
        f.auth.call(),
      )
      expect(error(output)).toBe('incompatible/exec_secret_env_unsupported')
      expect(JSON.stringify(output)).not.toContain(handle.handleId)
      scan(f.directory, ['not-real', 'rotated'], [output, handle])
    } finally {
      await broker.close()
      await f.close()
      cleanup(f.directory)
    }
  })
})
