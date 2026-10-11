import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type PowerShellDescriptor, probePowerShell } from '../../src/adapters/powershell.js'
import {
  powerShellCommand,
  powerShellDescription,
  powerShellScript,
  windowsCommandLineLength,
} from '../../src/adapters/powershell-command.js'

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
const core: PowerShellDescriptor = {
  path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  version: '7.6.5',
  edition: 'Core',
  nativeArguments: 'Windows',
}
const flags = ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text']
it.each([descriptor, core])(
  'retains an overlong command for preparation after policy authorization: $edition',
  (shell) => {
    const command = 'sensitive'.repeat(10_000)
    expect(powerShellScript(shell, powerShellCommand(shell, command))).toContain(command)
  },
)
it.each(['', 'bad\0command'])('refuses an invalid command: %s', (command) => {
  expect(() => powerShellCommand(descriptor, command)).toThrow('invalid PowerShell command')
})
// Windows PowerShell 5.1 serializes its error, warning and information streams to stderr as CLIXML
// whenever the command arrived through -EncodedCommand and stderr is redirected, -OutputFormat Text
// notwithstanding; PowerShell 7 honours -OutputFormat Text.
it('gives Windows PowerShell 5.1 the script as plain -Command text, so stderr is not CLIXML', () => {
  const argv = powerShellCommand(descriptor, 'Write-Error \'中文 "quoted" \\\\\'')
  expect(argv.slice(0, -1)).toEqual([descriptor.path, ...flags, '-Command'])
  expect(argv).not.toContain('-EncodedCommand')
  expect(argv.at(-1)).toMatch(/^\$OutputEncoding = .*\nWrite-Error '中文 "quoted" \\\\'$/s)
})
it('keeps -EncodedCommand for PowerShell 7, which honours -OutputFormat Text', () => {
  const argv = powerShellCommand(core, 'Write-Error x')
  expect(argv.slice(0, -1)).toEqual([core.path, ...flags, '-EncodedCommand'])
  expect(Buffer.from(argv.at(-1) as string, 'base64').toString('utf16le')).toMatch(/\nWrite-Error x$/)
})
it('switches the session to UTF-8 and drops progress records before the command runs', () => {
  for (const shell of [descriptor, core]) {
    const script = powerShellScript(shell, powerShellCommand(shell, 'command')) as string
    expect(script.split('\n').slice(0, 4)).toEqual([
      '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '[Console]::InputEncoding = $OutputEncoding',
      '[Console]::OutputEncoding = $OutputEncoding',
      "$ProgressPreference = 'SilentlyContinue'",
    ])
  }
})
it('makes Windows PowerShell 5.1 read files without a byte order mark, and write >, as UTF-8', () => {
  const defaults = (shell: PowerShellDescriptor) =>
    (powerShellScript(shell, powerShellCommand(shell, 'command')) as string)
      .split('\n')
      .filter((line) => line.startsWith('$PSDefaultParameterValues'))
  expect(defaults(descriptor)).toEqual([
    "$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'",
    "$PSDefaultParameterValues['Select-String:Encoding'] = 'UTF8'",
    "$PSDefaultParameterValues['Out-File:Encoding'] = 'UTF8'",
  ])
  expect(defaults(core)).toEqual([])
})
it('recognizes only an argv it built', () => {
  const argv = powerShellCommand(core, 'command')
  expect(powerShellScript(descriptor, argv)).toBeUndefined()
  expect(powerShellScript(core, [...argv, 'extra'])).toBeUndefined()
  expect(powerShellScript(core, ['other.exe', ...argv.slice(1)])).toBeUndefined()
  expect(() => powerShellScript(core, [...argv.slice(0, -1), 'not base64!'])).toThrow(
    expect.objectContaining({ code: 'E_SHELL_COMMAND' }),
  )
})
it('measures the command line as Windows receives it, quotes and escapes included', () => {
  // Quoted when it has a space, tab or quote; a quote, and the backslashes before it or before the
  // closing quote, are escaped.
  expect(windowsCommandLineLength(['C:\\a b\\x.exe'])).toBe(14)
  expect(windowsCommandLineLength(['plain', ''])).toBe(8)
  expect(windowsCommandLineLength(['a "b"'])).toBe(9)
  expect(windowsCommandLineLength(['a\\\\"b'])).toBe(10)
  expect(windowsCommandLineLength(['a b\\\\'])).toBe(9)
  expect(windowsCommandLineLength(['a\\b c'])).toBe(7)
  expect(windowsCommandLineLength(['中文 🙂'])).toBe(7)
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
    expect(child.stderr).not.toContain('CLIXML')
  })
  it('writes errors, warnings and Write-Host output as text, never CLIXML', async () => {
    const shell = await probePowerShell(path)
    const [executable, ...argv] = powerShellCommand(
      shell,
      "Write-Host '主机 host'; Write-Warning '警告 careful'; Write-Error '错误 failure'; Write-Output 'done'",
    )
    if (!executable) throw new Error('missing executable')
    const child = spawnSync(executable, argv, { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    expect(child.error).toBeUndefined()
    expect(child.stderr).not.toContain('CLIXML')
    expect(child.stderr).toContain('错误 failure')
    expect(child.stdout).toContain('主机 host')
    expect(child.stdout).toContain('done')
    expect(`${child.stdout}${child.stderr}`).toContain('警告 careful')
  })
  it('reads UTF-8 files without a byte order mark as UTF-8, and writes > as UTF-8', async () => {
    const shell = await probePowerShell(path)
    const root = mkdtempSync(join(tmpdir(), 'agnes-powershell-encoding-'))
    try {
      const file = join(root, 'plain.txt')
      const out = join(root, 'out.txt')
      writeFileSync(file, '中文 café\n')
      const [executable, ...argv] = powerShellCommand(
        shell,
        `Get-Content -LiteralPath ${quote(file)}; (Select-String -LiteralPath ${quote(file)} -Pattern 'caf').Line; '写入' > ${quote(out)}`,
      )
      if (!executable) throw new Error('missing executable')
      const child = spawnSync(executable, argv, { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      expect(child.error).toBeUndefined()
      expect(child.stderr).toBe('')
      expect(child.stdout.split(/\r?\n/).filter(Boolean)).toEqual(['中文 café', '中文 café'])
      expect(readFileSync(out, 'utf8').replace(/^﻿/, '')).toBe('写入\r\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
