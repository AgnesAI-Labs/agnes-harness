import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createReferenceExec } from '../../../../examples/runtime-reference/src/providers/exec.js'
import { cleanup, error, must, resolveInput, scan, secrets } from './network-secrets-fixture.js'
import { fixture } from './sandbox-exec-fixture.js'

describe.each(['default', 'reference'] as const)('%s execution admission', (kind) => {
  it.each([
    ['win32', 'exec_limit_openFiles_unsupported'],
    ['darwin', 'exec_limit_memoryBytes_unsupported'],
    ['linux', 'exec_platform_unsupported'],
  ] as const)('refuses mandatory hard gates on %s without advertising execution', async (os, detail) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: os, configurable: true })
    let f: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      f = await fixture(kind)
      const reply = await f.exec.run(
        {
          sandboxRef: {
            authorityId: 'sandbox-authority',
            sandboxId: 'unqualified',
            ownerBinding: f.sandbox.binding,
            lease: f.mount.lease,
          },
          argv: [process.execPath],
          cwd: { mount: f.mount, path: '' },
          env: [],
          stdinRef: null,
          limits: f.createInput.resourceLimits,
        },
        f.auth.call(),
      )
      expect(error(reply)).toBe(`incompatible/${detail}`)
      for (const field of Object.keys(f.createInput.resourceLimits)) {
        const zero = await f.exec.run(
          {
            sandboxRef: {
              authorityId: 'sandbox-authority',
              sandboxId: 'zero',
              ownerBinding: f.sandbox.binding,
              lease: f.mount.lease,
            },
            argv: [process.execPath],
            cwd: { mount: f.mount, path: '' },
            env: [],
            stdinRef: null,
            limits: { ...f.createInput.resourceLimits, [field]: 0 },
          },
          f.auth.call(),
        )
        expect(error(zero)).toBe(`quota/exec_zero_${field}`)
      }
      expect(f.exec.features).toEqual([])
      expect(f.sandbox.features).toEqual([])
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform)
      if (f) {
        await f.close()
        cleanup(f.directory)
      }
    }
  })
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

it('returns the same refusal code for identical inputs across both execution recipes', async () => {
  const f = await fixture()
  const reference = createReferenceExec({ ...f.execOptions, directory: join(f.directory, 'cross') })
  try {
    const request = {
      sandboxRef: {
        authorityId: 'sandbox-authority',
        sandboxId: 'unqualified',
        ownerBinding: f.sandbox.binding,
        lease: f.mount.lease,
      },
      argv: ['/bin/echo'],
      cwd: { mount: f.mount, path: '' },
      env: [],
      stdinRef: null,
      limits: f.createInput.resourceLimits,
    }
    for (const patch of [
      {},
      { argv: [] },
      { limits: { ...request.limits, memoryBytes: 1 } },
      { limits: { ...request.limits, processes: 1 } },
      ...Object.keys(request.limits).map((field) => ({ limits: { ...request.limits, [field]: 0 } })),
    ]) {
      const input = { ...request, ...patch },
        call = f.auth.call()
      expect(error(await f.exec.run(input, call))).toBe(error(await reference.run(input, call)))
    }
  } finally {
    await reference.close()
    await f.close()
    cleanup(f.directory)
  }
})
