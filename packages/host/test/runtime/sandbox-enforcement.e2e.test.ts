import { existsSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createReferenceExec } from '../../../../examples/runtime-reference/src/providers/exec.js'
import { createReferenceSandbox } from '../../../../examples/runtime-reference/src/providers/sandbox.js'
import { createExecService } from '../../src/runtime/providers/exec.js'
import { cleanup, error, must } from './network-secrets-fixture.js'
import { fixture } from './sandbox-exec-fixture.js'

describe.skipIf(process.platform !== 'darwin')('sandbox enforcement through real commands', () => {
  it.each(['default', 'reference'] as const)(
    '%s proves the floor, runs in the admitted root, denies host escape',
    async (kind) => {
      const f = await fixture(kind)
      try {
        const s = await f.ready()
        expect(s.filesystemProof.probes).toHaveLength(5)
        for (const probe of s.filesystemProof.probes) {
          const protectedPath = join(f.roots[probe.root], probe.path)
          writeFileSync(join(protectedPath, 'inside'), 'floor-fixture')
          for (const operation of ['read', 'write', 'stat', 'list']) {
            const argv =
              operation === 'read'
                ? ['/bin/cat', join(protectedPath, 'inside')]
                : operation === 'write'
                  ? ['/usr/bin/touch', join(protectedPath, 'created')]
                  : operation === 'stat'
                    ? ['/usr/bin/stat', protectedPath]
                    : ['/bin/ls', protectedPath]
            const denied = must(await f.exec.run(f.request(s, argv), f.auth.call()))
            expect(denied.exitCode).not.toBe(0)
            expect(existsSync(join(protectedPath, 'created'))).toBe(false)
          }
        }
        const normal = must(await f.exec.run(f.request(s, ['/bin/echo', 'hello']), f.auth.call()))
        expect(normal.exitCode).toBe(0)
        expect(f.bytes(normal.stdoutRef).toString()).toBe('hello\n')
        for (const path of ['../home', f.roots.home]) {
          const refused = await f.exec.run(
            f.request(s, ['/bin/echo', 'escape'], { cwd: { mount: f.mount, path } }),
            f.auth.call(),
          )
          expect(error(refused)).toBe('invalid_input/sandbox_path')
        }
        const denied = must(
          await f.exec.run(f.request(s, ['/usr/bin/stat', `${f.roots.home}/.ssh`]), f.auth.call()),
        )
        expect(denied.exitCode).not.toBe(0)
        expect(f.bytes(denied.stderrRef).toString()).toMatch(/Operation not permitted|Permission denied/)
        const link = join(f.roots.workspace, 'outside')
        symlinkSync(f.roots.home, link)
        expect(
          error(
            await f.exec.run(
              f.request(s, ['/bin/echo'], { cwd: { mount: f.mount, path: 'outside' } }),
              f.auth.call(),
            ),
          ),
        ).toBe('invalid_input/sandbox_path')
        unlinkSync(link)
        mkdirSync(link)
        renameSync(link, `${link}-original`)
        symlinkSync(f.roots.home, link)
        expect(
          error(
            await f.exec.run(
              f.request(s, ['/bin/echo'], { cwd: { mount: f.mount, path: 'outside' } }),
              f.auth.call(),
            ),
          ),
        ).toBe('invalid_input/sandbox_path')
        const outside = join(f.roots.home, 'marker')
        writeFileSync(outside, 'outside-root')
        const hostRead = must(await f.exec.run(f.request(s, ['/bin/cat', outside]), f.auth.call()))
        expect(hostRead.exitCode).not.toBe(0)
        expect(f.bytes(hostRead.stdoutRef).toString()).toBe('')
        await f.release()
        expect(error(await f.exec.run(f.request(s, ['/bin/echo']), f.auth.call()))).toBe(
          'denied/sandbox_mount',
        )
      } finally {
        await f.close()
        cleanup(f.directory)
      }
    },
  )
  it('matches sandbox results and rejection codes for the same input', async () => {
    const f = await fixture(),
      ref = createReferenceSandbox({ ...f.sandboxOptions, directory: join(f.directory, 'cross-sandbox') })
    try {
      const call = f.auth.call(),
        a = must(await f.sandbox.create(f.createInput, call)),
        b = must(await ref.create(f.createInput, call))
      expect(a.achievedIsolation).toEqual(b.achievedIsolation)
      expect(a.limits).toEqual(b.limits)
      expect(a.filesystemProof.policyDigest).toEqual(b.filesystemProof.policyDigest)
      expect(a.filesystemProof.probes.map((p) => ({ ...p, path: p.path }))).toEqual(b.filesystemProof.probes)
      for (const mode of ['remote', 'none']) {
        expect(error(await f.sandbox.create({ ...f.createInput, mode }, f.auth.call()))).toBe(
          error(await ref.create({ ...f.createInput, mode }, f.auth.call())),
        )
      }
    } finally {
      await ref.close()
      await f.close()
      cleanup(f.directory)
    }
  })
  it.each(['default', 'reference'] as const)(
    '%s refuses a directory moved outside after admission',
    async (kind) => {
      const f = await fixture(kind),
        selected = kind === 'default' ? createExecService : createReferenceExec
      const childPath = join(f.roots.workspace, 'child'),
        moved = join(f.roots.home, 'moved')
      mkdirSync(childPath)
      const executor = selected({
        ...f.execOptions,
        directory: join(f.directory, 'race'),
        sandbox: {
          withExecution(body, context, run) {
            return f.sandbox.withExecution(body, context, (launch) => {
              renameSync(childPath, moved)
              symlinkSync(f.roots.home, childPath)
              return run(launch)
            })
          },
        },
      })
      try {
        const s = await f.ready()
        const reply = await executor.run(
          f.request(s, ['/usr/bin/touch', 'escaped'], { cwd: { mount: f.mount, path: 'child' } }),
          f.auth.call(),
        )
        expect(reply.ok).toBe(false)
        expect(existsSync(join(moved, 'escaped'))).toBe(false)
        expect(existsSync(join(f.roots.home, 'escaped'))).toBe(false)
      } finally {
        await executor.close()
        await f.close()
        cleanup(f.directory)
      }
    },
  )
})
