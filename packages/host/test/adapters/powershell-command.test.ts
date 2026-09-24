import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type PowerShellDescriptor, probePowerShell } from '../../src/adapters/powershell.js'
import { powerShellCommand, powerShellDescription } from '../../src/adapters/powershell-command.js'

const descriptor: PowerShellDescriptor = {
  path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  version: '5.1.26100.9444',
  edition: 'Desktop',
  nativeArguments: 'Legacy',
}
it('describes exactly the selected version, executable and native argument mode', () => {
  const description = powerShellDescription(descriptor)
  expect(description).toContain(descriptor.version)
  expect(description).toContain(JSON.stringify(descriptor.path))
  expect(description).toContain('Legacy')
  expect(description).toContain('without && or ||')
})
it('retains an overlong command for preparation after policy authorization', () => {
  const command = 'sensitive'.repeat(10_000)
  expect(
    Buffer.from(powerShellCommand(descriptor, command).at(-1) as string, 'base64').toString('utf16le'),
  ).toContain(command)
})
it.each(['', 'bad\0command'])('refuses an invalid command: %s', (command) => {
  expect(() => powerShellCommand(descriptor, command)).toThrow('invalid PowerShell command')
})

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const realPaths = [
  win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  ),
  ...(process.env.AGNES_TEST_PWSH ? [process.env.AGNES_TEST_PWSH] : []),
]
describe.runIf(process.platform === 'win32').each(realPaths)('real script execution: %s', (path) => {
  it('uses the probed interpreter and preserves Chinese stdin and explicit exit 2', async () => {
    const shell = await probePowerShell(path)
    const input = '中文🙂 空格 "quotes" \\\\ tail\n'
    const [executable, ...argv] = powerShellCommand(
      shell,
      '[Console]::Out.Write([Console]::In.ReadToEnd()); exit 2',
    )
    if (!executable) throw new Error('missing executable')
    const child = spawnSync(executable, argv, { input, encoding: 'utf8', timeout: 5000, windowsHide: true })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(2)
    expect(child.stdout).toBe(input)
    expect(child.stderr).toBe('')
  })
  it('reports the same version to the script and forwards explicit native exit codes', async () => {
    const shell = await probePowerShell(path)
    const command =
      '[Console]::Out.Write($PSVersionTable.PSVersion.ToString()); & ' +
      quote(process.execPath) +
      " -e 'process.exit(7)'; exit $LASTEXITCODE"
    const [executable, ...argv] = powerShellCommand(shell, command)
    if (!executable) throw new Error('missing executable')
    const child = spawnSync(executable, argv, { encoding: 'utf8', timeout: 5000, windowsHide: true })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(7)
    expect(child.stdout).toBe(shell.version)
  })
  it('keeps ordinary PowerShell failure semantics', async () => {
    const shell = await probePowerShell(path)
    const [executable, ...argv] = powerShellCommand(shell, "throw 'fixture failure'")
    if (!executable) throw new Error('missing executable')
    const child = spawnSync(executable, argv, { encoding: 'utf8', timeout: 5000, windowsHide: true })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    expect(child.stderr).toContain('fixture failure')
  })
})
