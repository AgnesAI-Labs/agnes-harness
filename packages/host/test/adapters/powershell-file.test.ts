import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExec, createPolicyExec, type ExecAdapter } from '../../src/adapters/exec.js'
import { probePowerShell } from '../../src/adapters/powershell.js'
import { powerShellCommand } from '../../src/adapters/powershell-command.js'
import { preparePowerShellFile } from '../../src/adapters/powershell-file.js'

const roots: string[] = []
const adapters: ExecAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.killAll()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-long-中文 '))
  roots.push(root)
  vi.stubEnv('TEMP', root)
  vi.stubEnv('TMP', root)
  return root
}
const long = (command: string) => `#${'字'.repeat(20000)}\n${command}`
const paths = [
  win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  ),
  ...(process.env.AGNES_TEST_PWSH ? [process.env.AGNES_TEST_PWSH] : []),
]
describe.runIf(process.platform === 'win32').each(paths)('private PowerShell script: %s', (path) => {
  it('creates private UTF16 content and an encoded bootstrap, then removes exactly its files', async () => {
    const root = temporary()
    const shell = await probePowerShell(path)
    const argv = powerShellCommand(shell, long('exit 7'))
    expect(readdirSync(root)).toEqual([])
    const prepared = preparePowerShellFile(shell, argv)
    try {
      expect(prepared.argv.join(' ').length).toBeLessThan(30000)
      expect(prepared.scriptFile).toBeTypeOf('string')
      const file = prepared.scriptFile as string
      expect(hasPrivateDaclSync(file)).toBe(true)
      expect(hasPrivateDaclSync(dirname(file))).toBe(true)
      expect(readFileSync(file).equals(Buffer.from(argv.at(-1) as string, 'base64'))).toBe(true)
    } finally {
      prepared.dispose()
    }
    expect(readdirSync(root)).toEqual([])
  })
  it('keeps stdin and explicit exit for long commands, and still refuses unauthorized execution', async () => {
    const root = temporary()
    const shell = await probePowerShell(path)
    const exec = createExec({ windowsNodeExecutable: process.execPath, windowsPowerShell: shell })
    adapters.push(exec)
    const command = powerShellCommand(shell, long('[Console]::Out.Write([Console]::In.ReadToEnd()); exit 7'))
    const policyExec = createPolicyExec(exec, {
      boundDigest: () => 'test-digest',
      state: () => ({ backend: 'none', onUnavailable: 'deny' }),
      authorizeCwd: async (cwd) => cwd,
    })
    await expect(
      policyExec(command, { cwd: root, sandbox: { policyDigest: 'test-digest', backend: 'none' } }),
    ).rejects.toThrow()
    expect(readdirSync(root)).toEqual([])
    expect(await exec.run(command, { cwd: root, stdin: '中文🙂', timeoutMs: 5000 })).toMatchObject({
      code: 7,
      stdout: '中文🙂',
      stderr: '',
    })
    expect(readdirSync(root)).toEqual([])
  })
  it('retains throw semantics and removes the failed script', async () => {
    const root = temporary()
    const shell = await probePowerShell(path)
    const exec = createExec({ windowsNodeExecutable: process.execPath, windowsPowerShell: shell })
    adapters.push(exec)
    expect(
      await exec.run(powerShellCommand(shell, long("throw 'long fixture error'")), { cwd: root }),
    ).toMatchObject({ code: 1, stderr: expect.stringContaining('long fixture error') })
    expect(readdirSync(root)).toEqual([])
  })
  it('removes the script after execution times out', async () => {
    const root = temporary()
    const shell = await probePowerShell(path)
    const exec = createExec({ windowsNodeExecutable: process.execPath, windowsPowerShell: shell })
    adapters.push(exec)
    expect(
      await exec.run(powerShellCommand(shell, long('Start-Sleep 30')), { cwd: root, timeoutMs: 1000 }),
    ).toMatchObject({ timedOut: true })
    expect(readdirSync(root)).toEqual([])
  })
  it('removes the script when the interpreter cannot start', async () => {
    const root = temporary()
    const shell = await probePowerShell(path)
    const missing = { ...shell, path: join(root, 'missing.exe') }
    const invalid = createExec({ windowsNodeExecutable: process.execPath, windowsPowerShell: missing })
    adapters.push(invalid)
    await expect(
      invalid.run(powerShellCommand(missing, long('exit 0')), { cwd: root }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(existsSync(root)).toBe(true)
    expect(readdirSync(root)).toEqual([])
  })
  it('waits for cancellation before removing a running long script', async () => {
    const root = temporary()
    const shell = await probePowerShell(path)
    const exec = createExec({ windowsNodeExecutable: process.execPath, windowsPowerShell: shell })
    adapters.push(exec)
    const marker = join(root, 'ready')
    const command = `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}','ready'); Start-Sleep 30`
    const pending = exec.run(powerShellCommand(shell, long(command)), { cwd: root })
    await expect.poll(() => existsSync(marker), { timeout: 5000 }).toBe(true)
    expect(readdirSync(root).some((name) => name.startsWith('agnes-powershell-'))).toBe(true)
    await exec.killAll()
    expect(await pending).toMatchObject({ timedOut: false, signal: 'SIGKILL' })
    expect(readdirSync(root)).toEqual(['ready'])
  })
})

it.runIf(process.platform === 'win32')(
  'removes actual prepared script content when its Host process is killed',
  async () => {
    const root = temporary()
    const ready = join(root, 'ready.json')
    const prepareUrl = new URL('../../src/adapters/powershell-file.ts', import.meta.url).href
    const commandUrl = new URL('../../src/adapters/powershell-command.ts', import.meta.url).href
    const owner = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
    import {preparePowerShellFile} from ${JSON.stringify(prepareUrl)};
    import {powerShellCommand} from ${JSON.stringify(commandUrl)};
    import {writeFileSync} from 'node:fs';
    const shell={path:${JSON.stringify(paths[0])},version:'5.1.0',edition:'Desktop',nativeArguments:'Legacy'};
    const prepared=preparePowerShellFile(shell,powerShellCommand(shell,'#'+'x'.repeat(20000)+'\\nexit 0'));
    writeFileSync(${JSON.stringify(ready)},JSON.stringify({file:prepared.scriptFile}));
    setInterval(()=>{},1000);
  `,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let errors = ''
    owner.stderr.on('data', (chunk) => {
      errors += String(chunk)
    })
    try {
      await expect.poll(() => existsSync(ready), { timeout: 5000 }).toBe(true)
      const { file } = JSON.parse(readFileSync(ready, 'utf8')) as { file: string }
      expect(file, errors).toBeTypeOf('string')
      expect(readFileSync(file).length).toBeGreaterThan(30000)
      owner.kill('SIGKILL')
      await once(owner, 'exit')
      expect(existsSync(file)).toBe(false)
      expect(readdirSync(dirname(file))).toEqual([])
      const shell = await probePowerShell(paths[0] as string)
      const next = preparePowerShellFile(shell, powerShellCommand(shell, long('exit 0')))
      try {
        expect(existsSync(dirname(file))).toBe(false)
        expect(existsSync(next.scriptFile as string)).toBe(true)
      } finally {
        next.dispose()
      }
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill('SIGKILL')
        await once(owner, 'exit')
      }
    }
  },
)
