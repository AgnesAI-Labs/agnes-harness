import { execFile } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type BackendProbeExec, detectBackend, NONE_BACKEND } from '../src/backends.js'

it.skipIf(process.platform !== 'linux')(
  'either confines the actual Linux command or refuses an unavailable boundary',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-linux-sandbox-'))
    const outside = join(tmpdir(), `agnes-denied-${root.split('/').at(-1)}`)
    const probeExec: BackendProbeExec = (argv, options) =>
      new Promise((done) => {
        const [file, ...args] = argv
        if (!file) throw new Error('missing executable')
        execFile(
          file,
          args,
          { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes },
          (error, stdout, stderr) =>
            done({
              code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
              stdout,
              stderr,
              truncated: false,
              timedOut: Boolean(error && 'killed' in error && error.killed),
            }),
        )
      })
    const options = { cwd: root, allowPaths: [root], denyPaths: [], networkAllow: [] }
    try {
      const backend = await detectBackend({
        level: 'L1',
        shell: 'posix',
        options,
        probeExec,
        log: { debug() {}, info() {}, warn() {}, error() {} },
      })
      if (backend === NONE_BACKEND) {
        expect(backend.enforcement).toEqual({ level: 'none', scope: [] })
        expect(() => backend.confine(['/bin/sh', '-c', 'true'], options)).toThrow(
          'E_SANDBOX_HOST_ENFORCEMENT_REQUIRED',
        )
      } else {
        expect(backend.name).toBe('bwrap')
        expect(backend.enforcement).toEqual({ level: 'full', scope: ['file', 'network', 'process'] })
        const execute = (argv: string[]) =>
          probeExec(backend.confine(argv, options), { cwd: root, timeoutMs: 3000, maxOutputBytes: 4096 })
        expect((await execute(['/usr/bin/touch', join(root, 'allowed')])).code).toBe(0)
        await access(join(root, 'allowed'))
        expect((await execute(['/usr/bin/touch', outside])).code).not.toBe(0)
      }
      await expect(access(outside)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { force: true })
    }
  },
  15000,
)
