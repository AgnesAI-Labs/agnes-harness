import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxWorkspaceProbe } from '@agnes/base'
import { expect, it } from 'vitest'
import { sandboxReadPaths } from '../src/sandbox-read-paths.js'

it.skipIf(process.platform !== 'linux')(
  'keeps missing and later-created private trees hidden without creating host mount points',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-read-view-'))
    const denied = join(root, 'memory')
    const options = {
      cwd: root,
      allowPaths: [],
      denyPaths: [denied],
      get readPaths() {
        return sandboxReadPaths([denied])
      },
    }
    const probeExec = (
      argv: readonly string[],
      options: { cwd: string; timeoutMs: number; maxOutputBytes: number },
    ) =>
      new Promise<{ code: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }>(
        (done) => {
          execFile(
            argv[0]!,
            argv.slice(1),
            { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes },
            (error, stdout, stderr) =>
              done({
                code: error ? -1 : 0,
                stdout,
                stderr,
                truncated: false,
                timedOut: Boolean(error?.killed),
              }),
          )
        },
      )
    try {
      const available = await probeExec(
        [
          'bwrap',
          '--ro-bind',
          '/',
          '/',
          '--unshare-pid',
          '--unshare-ipc',
          '--unshare-uts',
          '--unshare-net',
          '/bin/true',
        ],
        { cwd: root, timeoutMs: 3000, maxOutputBytes: 4096 },
      )
      const backend = await sandboxWorkspaceProbe({
        level: 'L1',
        required: false,
        onUnavailable: 'deny',
        shell: 'posix',
        options,
        probeExec,
        log: { debug() {}, info() {}, warn() {}, error() {} },
      })
      expect(backend.execBackend).toBe(available.code === 0 ? 'l1' : 'none')
      if (backend.execBackend === 'none') {
        expect(() => backend.confine({ argv: ['/bin/cat', denied], cwd: root })).toThrow(
          'SANDBOX_UNAVAILABLE',
        )
        return
      }
      expect(backend.enforcement.level).toBe('full')
      await writeFile(join(root, 'public.md'), 'public')
      const read = async (path: string) =>
        probeExec(await backend.confine({ argv: ['/bin/cat', path], cwd: root }), {
          cwd: root,
          timeoutMs: 3000,
          maxOutputBytes: 4096,
        })
      expect((await read(join(root, 'public.md'))).stdout).toBe('public')
      await expect(access(denied)).rejects.toMatchObject({ code: 'ENOENT' })
      await mkdir(denied)
      await writeFile(join(denied, 'MEMORY.md'), 'PRIVATE_MARKER')
      await symlink(denied, join(root, 'alias'))
      for (const path of [join(denied, 'MEMORY.md'), join(root, 'alias/MEMORY.md')]) {
        const result = await read(path)
        expect(result.code).not.toBe(0)
        expect(result.stdout).not.toContain('PRIVATE_MARKER')
      }
      expect((await read(join(root, 'public.md'))).stdout).toBe('public')
      const write = await probeExec(
        await backend.confine({ argv: ['/usr/bin/touch', join(root, 'outside.md')], cwd: root }),
        { cwd: root, timeoutMs: 3000, maxOutputBytes: 4096 },
      )
      expect(write.code).not.toBe(0)
      await expect(access(join(root, 'outside.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
