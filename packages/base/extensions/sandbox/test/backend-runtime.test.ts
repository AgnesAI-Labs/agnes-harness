import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { BackendProbeExec, DetectBackendInput } from '../src/backends.js'
import { detectBackend, NONE_BACKEND } from '../src/backends.js'

const options = {
  cwd: '/work/proj',
  allowPaths: ['/work/proj'],
  denyPaths: [] as string[],
  networkAllow: [] as string[],
}

const result = (code: number, stdout = '') => ({
  code,
  stdout,
  stderr: '',
  truncated: false,
  timedOut: false,
})

function input(probeExec: BackendProbeExec, over: Partial<DetectBackendInput> = {}): DetectBackendInput {
  return {
    level: 'L1',
    shell: 'posix',
    options,
    probeExec,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...over,
  }
}

describe('runtime backend detection', () => {
  it('requires a successful run of the complete bwrap boundary, not a version/presence check', async () => {
    const probe = vi.fn<BackendProbeExec>(async (argv) =>
      argv[0] === 'bwrap' && argv.includes('--unshare-net') && argv.includes('--unshare-pid')
        ? result(0, 'agnes-sandbox-probe-v1')
        : result(127),
    )
    const backend = await detectBackend(input(probe))
    expect(backend.name).toBe('bwrap')
    expect(backend.enforcement).toEqual({ level: 'full', scope: ['file', 'network', 'process'] })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0]?.[0]).toContain('--die-with-parent')
  })

  it('falls through a present-but-unusable bwrap and requires Seatbelt to run its generated profile', async () => {
    const calls: string[][] = []
    const backend = await detectBackend(
      input(async (argv) => {
        calls.push(argv)
        if (argv[0] === 'bwrap') return result(1)
        if (argv[0] === '/usr/bin/sandbox-exec' && argv[1] === '-p')
          return result(0, 'agnes-sandbox-probe-v1')
        return result(127)
      }),
    )
    expect(calls.map((argv) => argv[0])).toEqual(['bwrap', '/usr/bin/sandbox-exec'])
    expect(backend.name).toBe('seatbelt')
    expect(calls[1]?.[2]).toContain('(deny network*)')
  })

  it('reports none after both real invocations fail and never returns raw argv from none', async () => {
    const backend = await detectBackend(input(async () => result(127)))
    expect(backend).toBe(NONE_BACKEND)
    expect(backend.enforcement).toEqual({ level: 'none', scope: [] })
    expect(() => backend.confine(['echo', 'unsafe'], options)).toThrow(/E_SANDBOX_HOST_ENFORCEMENT_REQUIRED/)
  })

  it.each([
    { level: 'L0' as const, shell: 'posix' as const },
    { level: 'L1' as const, shell: 'powershell' as const },
  ])('does not probe an inapplicable or unenforceable platform: %j', async (over) => {
    const probe = vi.fn<BackendProbeExec>(async () => result(0, 'agnes-sandbox-probe-v1'))
    expect(await detectBackend(input(probe, over))).toBe(NONE_BACKEND)
    expect(probe).not.toHaveBeenCalled()
  })

  it('fails closed on a network host allowlist instead of treating it as backend unavailability', async () => {
    const probe = vi.fn<BackendProbeExec>(async () => result(0, 'agnes-sandbox-probe-v1'))
    await expect(
      detectBackend(
        input(probe, {
          options: { ...options, networkAllow: ['api.example.com'] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'E_SANDBOX_NETWORK_ALLOWLIST_UNSUPPORTED' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('requires the exact probe token, a clean exit and no timeout', async () => {
    for (const bad of [
      result(0, 'wrong'),
      result(1, 'agnes-sandbox-probe-v1'),
      { ...result(0, 'agnes-sandbox-probe-v1'), timedOut: true },
    ]) {
      expect(await detectBackend(input(async () => bad))).toBe(NONE_BACKEND)
    }
  })
})

const actualSeatbelt = it.runIf(existsSync('/usr/bin/sandbox-exec'))
actualSeatbelt('selects Seatbelt through the real generated profile on macOS', async () => {
  const probeExec: BackendProbeExec = (argv, probeOptions) =>
    new Promise((resolve) => {
      const [file, ...args] = argv
      if (!file) throw new Error('missing executable')
      execFile(
        file,
        args,
        { cwd: probeOptions.cwd, timeout: probeOptions.timeoutMs, maxBuffer: probeOptions.maxOutputBytes },
        (error, stdout, stderr) => {
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
            stdout,
            stderr,
            truncated: false,
            timedOut: Boolean(error && 'killed' in error && error.killed),
          })
        },
      )
    })
  const backend = await detectBackend(
    input(probeExec, {
      options: { cwd: '/tmp', allowPaths: [], denyPaths: [], networkAllow: [] },
    }),
  )
  expect(backend.name).toBe('seatbelt')
})
