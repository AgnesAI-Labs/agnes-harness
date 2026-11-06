import { win32 } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { probePowerShell } from '../../src/adapters/powershell.js'

const execute = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})
const path = 'C:\\private-location\\powershell.exe'
const descriptor = { path, version: '5.1.26100.9444', edition: 'Desktop', nativeArguments: 'Legacy' }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  execute.mockReset()
})
function capture(trace = '1') {
  vi.stubEnv('AGNES_POWERSHELL_PROBE_TRACE', trace)
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  return () => write.mock.calls.map(([line]) => JSON.parse(String(line)))
}
async function capturedScript() {
  execute.mockResolvedValue({ stdout: JSON.stringify(descriptor), stderr: '' })
  await probePowerShell(path)
  const args = execute.mock.calls.at(-1)?.[1] as string[]
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1] as string, 'base64').toString('utf16le')
}
const actualShell =
  process.env.AGNES_TEST_PWSH ??
  (process.platform === 'win32' && process.env.SystemRoot
    ? win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : undefined)
it.runIf(Boolean(actualShell))(
  'runs the encoded metadata script without autoload and escapes JSON strings losslessly',
  async () => {
    const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const script = await capturedScript()
    const run = (value: string) =>
      JSON.parse(
        execFileSync(
          actualShell as string,
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-OutputFormat',
            'Text',
            '-EncodedCommand',
            Buffer.from(`$PSModuleAutoLoadingPreference = 'None'\n${value}`, 'utf16le').toString('base64'),
          ],
          { encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384, windowsHide: true },
        )
          .replace(/^\uFEFF/, '')
          .trim(),
      )
    const facts = run(script)
    expect(facts).toMatchObject({
      path: expect.any(String),
      version: expect.stringMatching(/^(5\.1|7)\./),
      edition: expect.stringMatching(/^(Desktop|Core)$/),
      nativeArguments: expect.stringMatching(/^(Legacy|Standard|Windows)$/),
      codePage: expect.any(Number),
    })
    expect(
      run(
        `if ($null -ne $ExecutionContext.SessionState.PSVariable.Get('PSNativeCommandArgumentPassing')) { $ExecutionContext.SessionState.PSVariable.Remove('PSNativeCommandArgumentPassing') }\n${script}`,
      ),
    ).toEqual({ ...facts, nativeArguments: 'Legacy' })
    const input = `C:\\工具 space "quote"\\😀${Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('')}`
    const expression = `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(input, 'utf16le').toString('base64')}')) + [char]0xd800 + 'a' + [char]0xdfff`
    const escaped = script.replace(
      '$path = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName',
      `$path = ${expression}`,
    )
    expect(escaped).not.toBe(script)
    expect(run(escaped)).toEqual({ ...facts, path: `${input}\ud800a\udfff` })
  },
)
it.each(['', '0', 'true'])('keeps successful probes silent unless trace is exactly 1: %s', async (value) => {
  const records = capture(value)
  execute.mockResolvedValue({ stdout: JSON.stringify(descriptor), stderr: '' })
  expect(await probePowerShell(path)).toEqual(descriptor)
  expect(records()).toEqual([])
})
it('reports successful stage durations without shell facts and preserves the execution limits', async () => {
  const records = capture()
  const stdout = JSON.stringify(descriptor)
  execute.mockResolvedValue({ stdout, stderr: 'private diagnostics' })
  expect(await probePowerShell(path)).toEqual(descriptor)
  expect(execute.mock.calls[0]?.[2]).toEqual({
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16_384,
    windowsHide: true,
  })
  expect(records().map(({ phase, outcome }) => [phase, outcome])).toEqual([
    ['execute', 'success'],
    ['decode', 'success'],
    ['validate', 'success'],
  ])
  for (const record of records()) {
    expect(record.durationMs).toBeGreaterThanOrEqual(0)
    expect(record.stdoutBytes).toBe(Buffer.byteLength(stdout))
    expect(record.stderrBytes).toBe(Buffer.byteLength('private diagnostics'))
  }
  expect(JSON.stringify(records())).not.toMatch(/private|26100|Desktop|Legacy/)
})
it.each([
  ['execute', { code: 'ENOENT', errno: -4058, signal: 'SIGTERM', killed: true }, 'ENOENT', 'SIGTERM'],
  ['execute', { code: 23, signal: 'SIGKILL' }, 23, 'SIGKILL'],
  ['execute', { code: 'secret-code', errno: 'secret-errno', signal: 'secret-signal' }, null, null],
  ['decode', null, null, null],
  ['validate', null, null, null],
] as const)(
  'reports sanitized %s failures without changing unavailability',
  async (phase, failure, code, signal) => {
    const records = capture()
    if (phase === 'execute')
      execute.mockRejectedValue(
        Object.assign(new Error('private error'), failure, {
          stdout: 'private stdout',
          stderr: Buffer.from('private stderr'),
        }),
      )
    else
      execute.mockResolvedValue({
        stdout: phase === 'decode' ? 'private invalid JSON' : '{"private":"fact"}',
        stderr: '',
      })
    await expect(probePowerShell(path)).rejects.toMatchObject({
      code: 'E_POWERSHELL_UNAVAILABLE',
      attempts: [{ path, reason: 'probe-failed' }],
    })
    expect(records().at(-1)).toMatchObject({ phase, outcome: 'failure', code, signal })
    expect(JSON.stringify(records())).not.toMatch(/private|secret/)
  },
)
