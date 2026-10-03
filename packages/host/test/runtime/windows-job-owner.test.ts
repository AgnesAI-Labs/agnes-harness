import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runReferenceWindowsExecution } from '../../../../examples/runtime-reference/src/providers/exec.js'
import { runOwnedExecution } from '../../src/runtime/platform/resource-owners.js'
import { runWindowsJobExecution } from '../../src/runtime/platform/windows-job-owner.js'

const native = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: native.spawn }))
const input = () => ({
  argv: ['C:\\fixture.exe', '空 白', 'quote"\\'],
  cwd: '.',
  env: {},
  stdin: Buffer.from('payload'),
  signal: new AbortController().signal,
  fileMode: 'five-limits' as const,
  limits: { cpuMs: 1000, wallMs: 2000, memoryBytes: 268435456, outputBytes: 64, processes: 8 },
})
const metrics = {
  kind: 'metrics',
  pid: 123,
  final: true,
  reason: 'completed',
  code: 0,
  signal: 0,
  cpuMs: 1,
  rss: 4096,
  committedBytes: 8192,
  processes: 1,
  files: 0,
  filesEnforced: false,
  outputBytes: 5,
  intervalMs: 10,
  maxGapMs: 12,
  remaining: 0,
  ownershipVerified: true,
  residualObserved: 0,
  ownership: 'strong',
}
function frames(rows: unknown[], exit = 0, trailing = '') {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  native.spawn.mockReturnValueOnce(process)
  queueMicrotask(() => {
    process.stdout.write(rows.map((row) => JSON.stringify(row) + '\n').join('') + trailing)
    process.emit('close', exit)
  })
  return process
}
beforeEach(() => native.spawn.mockReset())
it('refuses the generic Windows owner even if an internal five-limit flag is present', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    await expect(
      runOwnedExecution({ ...input(), limits: { ...input().limits, openFiles: 32 } }),
    ).rejects.toThrow('exec_limit_openFiles_unsupported')
    expect(native.spawn).not.toHaveBeenCalled()
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
  }
})
describe.each([
  ['default', runWindowsJobExecution],
  ['reference', runReferenceWindowsExecution],
] as const)('%s injected Windows Job protocol', (_, run) => {
  it.each([undefined, 'files'] as const)(
    'refuses a requested File ceiling before any helper launch (%s)',
    async (fileMode) => {
      const { fileMode: _mode, ...request } = input()
      await expect(run({ ...request, ...(fileMode === undefined ? {} : { fileMode }) })).rejects.toThrow(
        'exec_limit_openFiles_unsupported',
      )
      expect(native.spawn).not.toHaveBeenCalled()
    },
  )
  it.each([0, 1, 256])('refuses any requested openFiles=%s despite the internal mode', async (openFiles) => {
    await expect(run({ ...input(), limits: { ...input().limits, openFiles } })).rejects.toThrow(
      'exec_limit_openFiles_unsupported',
    )
    expect(native.spawn).not.toHaveBeenCalled()
  })
  it('retains exact output and requires the Job-empty terminal evidence', async () => {
    frames([{ kind: 'output', stream: 0, hex: '68656c6c6f' }, metrics])
    const result = await run(input())
    expect(Buffer.from(result.stdout).toString()).toBe('hello')
    expect(result.stderr.byteLength).toBe(0)
    expect(result.metrics).toMatchObject({
      ownership: 'strong',
      remaining: 0,
      filesEnforced: false,
      committedBytes: 8192,
    })
  })
  it('accepts many bounded frames coalesced into one transport chunk', async () => {
    const request = input()
    request.limits.outputBytes = 100000
    frames([
      ...Array.from({ length: 200 }, () => ({ kind: 'output', stream: 0, hex: 'ab'.repeat(500) })),
      { ...metrics, outputBytes: 100000 },
    ])
    const result = await run(request)
    expect(Buffer.from(result.stdout)).toEqual(Buffer.alloc(100000, 0xab))
  })
  it.each(['cpuMs', 'wallMs', 'memoryBytes', 'outputBytes', 'processes'] as const)(
    'refuses zero %s before launch',
    async (field) => {
      const request = input()
      request.limits[field] = 0
      await expect(run(request)).rejects.toThrow('exec_resource_bounds')
      expect(native.spawn).not.toHaveBeenCalled()
    },
  )
  it.each([
    { ownershipVerified: false },
    { remaining: 1 },
    { remaining: -1 },
    { final: false },
    { ownership: 'cooperative' },
    { filesEnforced: true },
    { committedBytes: -1 },
    { outputBytes: 65 },
    { reason: 'openFiles' },
    { maxGapMs: null },
    { pid: 0 },
  ])('refuses incomplete or contradictory native evidence %j', async (patch) => {
    frames([{ ...metrics, ...patch }])
    await expect(run(input())).rejects.toThrow('exec_cleanup_unknown')
  })
  it.each([
    [[], 0, ''],
    [[metrics, metrics], 0, ''],
    [[metrics], 0, '{'],
    [[metrics], 125, ''],
    [[{ kind: 'output', stream: 0, hex: 'gg' }, metrics], 0, ''],
    [[{ kind: 'output', stream: 0, hex: 'aa'.repeat(65) }, metrics], 0, ''],
    [[{ kind: 'refusal', detailCode: 'unrecognized' }], 125, ''],
    [[{ kind: 'refusal', detailCode: 'exec_cleanup_unknown' }], 125, ''],
  ] as const)(
    'fails closed on malformed, missing or repeated terminal frames %#',
    async (rows, exit, tail) => {
      frames([...rows], exit, tail)
      await expect(run(input())).rejects.toThrow('exec_cleanup_unknown')
    },
  )
  it('preserves the explicit unavailable File-field refusal', async () => {
    frames([{ kind: 'refusal', detailCode: 'exec_limit_openFiles_unsupported' }], 125)
    await expect(run(input())).rejects.toThrow('exec_limit_openFiles_unsupported')
  })
  it('reports a qualification-only five-limit result without claiming files were enforced', async () => {
    frames([{ ...metrics, reason: 'wallMs', files: 0, filesEnforced: false }])
    const result = await run({ ...input(), fileMode: 'five-limits' })
    expect(result.metrics.filesEnforced).toBe(false)
  })
  it('preserves cancellation without treating owner death as successful command completion', async () => {
    const abort = new AbortController()
    const child = frames([{ ...metrics, reason: 'cancel' }])
    const result = run({ ...input(), signal: abort.signal })
    abort.abort()
    expect(child.stdin.read().includes(Buffer.from('cancel'))).toBe(true)
    expect((await result).metrics.reason).toBe('cancel')
    await expect(run({ ...input(), signal: abort.signal })).rejects.toThrow('exec_cancelled')
  })
})
